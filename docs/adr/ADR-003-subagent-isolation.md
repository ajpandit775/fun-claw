# ADR-003: Subagent Isolation Model

## Status

Accepted. Locked.

## Context

Fun Claw supports multi-agent execution: a parent agent can spawn subagents to handle subtasks. This is one of the locked features in the v0.6 spec, taken from TinyClaw's ambition done cleanly. The design question is how to isolate subagents from each other and from the parent: same context window or separate, same Docker container or separate, shared filesystem or separate, shared budget or separate.

## Decision

Each subagent runs in the same Node host process as the parent (no new V8 isolate, no new LLM client) but gets its own ephemeral Docker container. Each subagent has its own context window, its own tool budget, and its own wall-clock timeout. The subagent's final answer (its last assistant message text) is returned to the parent as a single `tool_result`.

A subagent is created by the parent calling the built-in `spawn_subagent(prompt, system?, tools?)` tool. The parameters are: `prompt` (required, the task for the subagent), `system` (optional, override system prompt), `tools` (optional, allowlist of tool names the subagent can use; defaults to inheriting the parent's allowed tools minus `spawn_subagent` itself).

Default budgets per subagent:
- Maximum recursion depth: 3 (parent → child → grandchild → great-grandchild blocked).
- Maximum concurrent subagents per parent: 5.
- Maximum input tokens: 50,000.
- Maximum agent loop iterations: 15.
- Wall-clock timeout: 300 seconds.

These are enforced by the spawn tool implementation. A subagent attempting to spawn a fifth concurrent sibling, or spawn at depth 4, gets a tool error result and the parent decides what to do.

## Implementation rules that follow

The spawn tool creates a new Docker container labeled `funclaw.session=<parentSessionId>` and `funclaw.subagent=<subagentId>` so cleanup logic finds it. The container is ephemeral: it is created at spawn time and destroyed immediately when the subagent's loop exits, regardless of success or failure.

The subagent has no shared state with the parent except what is explicitly passed in the spawn call. It does not see the parent's `/workspace` mount unless the spawn tool is configured to share it (default: yes, read-only). It does not see the parent's environment variables. It does not have the parent's tool list unless explicitly inherited.

Token usage tallies to the **root** agent for cost accounting. A 5-deep tree of subagents charges all token costs to the root session in logs and any future cost reports. This is so users see the true cost of a request, not a misleadingly small "parent spent X tokens" number that hides 10x more spend in subagents.

If a subagent throws (catches an unexpected exception, hits OOM, container dies), the throw is caught at the spawn boundary and converted to a `tool_result` with `isError: true` containing the error class and message (no stack trace into the LLM context). The parent then decides whether to retry or route around.

Subagent abort never cancels the parent. A user pressing Ctrl-C in the parent's TUI cancels everything, but a subagent's internal abort (timeout, max iterations) is a contained event.

Subagents are not telemetered, monitored, or instrumented separately from the parent. Logs include the subagent's UUID so a user can filter by it post-hoc, but there is no special "subagent metrics" surface in v1.

## Consequences

Each subagent paying for its own container start (~300-800ms on Linux/macOS, 1-2s on Windows Docker Desktop) is a real latency cost. We accept this in exchange for clean isolation: a subagent's `cd` doesn't affect the parent's working directory, a subagent's mutations to `/tmp` are gone the moment it exits, and a subagent's filesystem writes are confined to its own container.

The 5-concurrent limit and depth cap of 3 prevents subagent explosion. A pathological LLM trying to spawn 100 subagents to brute-force a problem hits the cap and gets a tool error.

The 50K input-token budget per subagent is significant — it's larger than most subagent prompts need but small enough to prevent context-window abuse. Combined with the 15-iteration cap, a subagent can do real work without burning unbounded tokens.

The "in-process, separate container" model is the simplest correct option. Separate processes would add IPC complexity. Separate containers per subagent is the only filesystem-isolation answer that doesn't require Linux-specific namespace gymnastics.

The subagent's final answer is text, not structured data. If the parent needs structured output, the parent prompts the subagent to return JSON and parses it. This is consistent with how LLMs handle structured output in normal turns.

## Alternatives considered

**Subagents share the parent's container.** Rejected. Filesystem mutations would leak between sibling subagents. `cd` in one subagent affects another. Defeats the parallelization story.

**Subagents are full separate processes (separate Node, separate LLM clients).** Rejected. Adds IPC complexity. No clear benefit over in-process subagents that already get container isolation. The parent's LLM client can serve all subagents fine.

**No depth cap, only concurrency cap.** Rejected. Deeply nested subagents amplify token costs exponentially and obscure debugging. A depth-of-3 limit catches almost all legitimate use cases (a research agent spawning analyzers spawning summarizers is depth 3).

**Subagents share the parent's context window.** Rejected. The whole point of subagents is to give them clean context for focused work. Sharing the parent's context defeats the purpose.

**Token budgets pooled across all subagents (single project-wide budget).** Deferred. Useful pattern but adds bookkeeping. v1 uses per-subagent budgets; pooled budgets are `[v2-or-never]`.

**Subagent results structured as JSON automatically.** Rejected. The LLM prompts can specify JSON output if needed. Forcing structured output forces all subagents into a JSON-only model, which doesn't fit narrative tasks.

## References

Architecture blueprint section 3.3. Cleanup labels (`funclaw.session`, `funclaw.subagent`) align with the cleanup design in section 3.4.
