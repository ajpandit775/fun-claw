# ADR-002: Tool Dispatch Model

## Status

Accepted. Locked.

## Context

When an LLM produces a turn that contains tool calls, those tool calls can be dispatched serially (one at a time, each waiting for the previous to complete) or in parallel (all dispatched simultaneously, results gathered when all complete). This is a fundamental architectural choice that affects latency, debuggability, and how the rest of the agent loop is shaped.

Anthropic, OpenAI, and Gemini all support multiple tool calls per turn. The wire format addresses each result by its `tool_use_id` (Anthropic) or `tool_call_id` (OpenAI), so result ordering is not positional — the LLM matches results to calls by ID, not by array index. This means parallel dispatch is correct as long as we preserve IDs end-to-end.

## Decision

Fun Claw dispatches tool calls in parallel by default.

When the LLM produces a turn with N tool calls, Fun Claw extracts all `tool_use` blocks from the response, fires `Promise.all(toolUses.map(executeOne))`, and gathers results into the next user message in the order the LLM expects (keyed by ID, not by completion time).

A single `AbortController` is threaded through the agent loop. A user-initiated abort (Ctrl-C in the TUI) cancels both the in-flight LLM stream and any in-flight tool executions.

Tool execution within the container is also parallel-friendly: each tool call gets its own `docker exec` against the session container, so concurrent tool calls don't block each other on the container side either.

The maximum number of concurrent tool calls per turn is capped at 10 by `p-limit`. If the LLM emits more than 10 tool calls in a single turn, the additional calls queue and execute as earlier ones complete. This prevents Docker daemon overload and prevents pathological cases where an LLM emits 100 parallel calls.

## Implementation rules that follow

The agent loop's per-turn execution looks like:

```typescript
const toolUses = turn.content.filter(b => b.type === 'tool_use') as ToolUseBlock[];
const limit = pLimit(10);
const results = await Promise.all(
  toolUses.map(t => limit(() => executeOne(t, abortSignal)))
);
messages.push({ role: 'user', content: results });
```

Tool results are gathered into a single `user` message containing all `tool_result` blocks, in the same order as the LLM's `tool_use` blocks (so the LLM can correlate by position too if it wants, though it should correlate by ID).

If a tool throws, the throw is caught at the dispatch boundary and converted to a structured `tool_result` with `isError: true`. Tool throws never propagate up to the agent loop. A failing tool does not abort the parallel batch — sibling tools continue and complete normally.

The agent loop has a hard cap of 25 iterations. After 25 turns of `stop_reason === 'tool_use'`, the loop exits with an error rather than continuing indefinitely.

## Consequences

Parallel dispatch reduces latency dramatically for tool-heavy turns. A turn with 5 tool calls each taking 2 seconds completes in ~2 seconds instead of ~10 seconds.

Parallel dispatch makes debugging harder. Logs from concurrent tool executions interleave. The logger must include the tool-use ID in every log line so the user can grep for a specific tool's lifecycle.

Parallel dispatch makes failure isolation cleaner. One failing tool doesn't block siblings. The LLM gets an error result for the failure and success results for the rest, and can decide whether to retry, route around the failure, or apologize.

Parallel dispatch is what users expect. Claude Code, Cursor, and Hermes all do parallel dispatch. Serial dispatch would feel slow.

The 10-concurrent cap is a defensive measure against pathological LLM behavior. In practice the LLM rarely emits more than 3-5 tool calls per turn.

## Alternatives considered

**Serial dispatch (one at a time).** Rejected. Latency is unacceptable for tool-heavy turns. Provides no debugging benefit that JSON logging with tool IDs doesn't already provide.

**Speculative dispatch (start tools before the LLM finishes streaming).** Rejected. Adds complexity, has correctness risks if the LLM decides to retract a tool call mid-stream, and most providers' streaming protocols don't expose tool calls until the final chunks anyway.

**Strict dependency-graph dispatch (analyze tool calls for dependencies, dispatch in topological order).** Rejected. Adds significant complexity. The LLM is already pretty good at not emitting truly dependent tool calls in the same turn — when it needs to use the result of one tool to call another, it does that across turns naturally. Building a dependency analyzer for the rare case is over-engineering.

**Per-tool concurrency limits (some tools allow concurrent, others require serial).** Deferred. If a specific tool has a concurrency requirement, the tool implementation can wrap itself in `pLimit(1)` internally. The dispatch layer doesn't need to know.

## References

Architecture blueprint section 3.2. The cap of 25 iterations matches the blueprint's max-iteration safeguard.
