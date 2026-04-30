// Fun Claw agent loop.
//
// Pure async generator that drives the LLM ↔ tool dispatch loop per
// ADR-002. Yields `AgentEvent`s for consumers (the chat TUI, smoke
// tests, future automation) to render.
//
// One iteration = one LLM call + (optional) parallel tool dispatch.
// Per ADR-002, the loop has a hard cap of 25 iterations of
// `stop_reason === "tool_use"` before exiting with FC-6001. Callers can
// override `maxIterations` via options.
//
// AbortSignal is threaded into both `provider.stream()` and each
// `ToolHandler` invocation (the docker-runner respects the signal in
// `SessionHandle.exec`). When the caller aborts (Ctrl-C in the TUI),
// the in-flight LLM stream and any running tool execs terminate
// cleanly; the loop yields a `turn-stop` with reason `"aborted"` and
// returns.
//
// Per ADR-001, every tool result is wrapped in
// `<tool_result tool="..." id="..." session="...">...</tool_result>`
// boundary markers before being placed back into the message history.
// The system prompt (see `system-prompt.ts`) instructs the LLM to treat
// content inside the markers as data, not instructions.
//
// Reference docs:
//   - docs/adr/ADR-001-trust-boundaries.md (LLM is semi-trusted; tool
//     output is adversarial; boundary markers).
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch; 25-iteration
//     cap; tool throws → ToolResult.isError; no abort on single tool
//     failure).

import pLimit from "p-limit";
import { funClawError, isFunClawError } from "./errors.js";
import type { LLMProvider, StreamOptions } from "./provider.js";
import type { ToolRegistry } from "./tool-registry.js";
import type {
  AgentEvent,
  AgentUsage,
  ContentBlock,
  FunClawError,
  Message,
  StopReason,
  ToolCall,
  ToolHandlerContext,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

/** Default per ADR-002. */
const DEFAULT_MAX_ITERATIONS = 25;

/** Maximum concurrent tool calls per turn (ADR-002 cap). */
const TOOL_CONCURRENCY = 10;

/**
 * Maximum concurrent `spawn_subagent` calls per turn (ADR-003 cap of
 * 5 sibling subagents per parent). This nests INSIDE the broader
 * `TOOL_CONCURRENCY` cap: a turn with 4 execute_bash + 6
 * spawn_subagent calls runs all 4 bash plus 5 of the subagents in
 * parallel; the 6th subagent waits.
 *
 * Per-turn instantiation is equivalent to per-parent because the
 * agent loop awaits all dispatches before starting the next turn —
 * there are never in-flight calls from a previous turn to count
 * against the cap.
 */
const SUBAGENT_CONCURRENCY = 5;

/**
 * Locked tool name for spawn_subagent. The agent loop's dispatcher
 * routes calls with this name through an additional `pLimit(5)`
 * before the broader `pLimit(10)` to enforce ADR-003's sibling cap.
 *
 * The magic-constant coupling is deliberate: the alternative (the
 * spawn_subagent handler self-limiting via a shared mutable counter)
 * is messier and harder to test. Keeping the cap at the dispatch
 * layer keeps the handler pure.
 */
export const SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent";

export interface AgentLoopOptions {
  /** The LLM provider (constructed via `createProvider` in the chat command). */
  provider: LLMProvider;
  /** Registered tools for this session. */
  registry: ToolRegistry;
  /** Conversation history seed. Typically `[{ role: "user", content }]`
   *  for a fresh chat or the carried-over messages from a continuing
   *  session. The system prompt is added by the loop, NOT included
   *  here — pass it via `systemPrompt`. */
  initialMessages: Message[];
  /** System prompt (built via `buildSystemPrompt`). */
  systemPrompt: string;
  /** Model identifier passed through to the provider. */
  model: string;
  /** UUID of the session — used in boundary markers. */
  sessionUuid: string;
  /** Defaults to 25 (ADR-002). */
  maxIterations?: number;
  /** Maximum tokens per LLM turn. Provider defaults apply if omitted. */
  maxTokens?: number;
  /** Caller's abort signal — fires on Ctrl-C, exit, etc. */
  abortSignal?: AbortSignal;
  /**
   * Callback fired whenever the loop appends a message to its internal
   * history. Called twice per tool-using turn (the assistant message,
   * then the user message containing the wrapped tool results) and
   * once per non-tool-using terminal turn (just the assistant message).
   *
   * Useful for consumers that want to keep their own copy of the
   * protocol history synchronized — e.g., the chat TUI tracking
   * messages across user submits without rebuilding from events. The
   * messages passed here have ADR-001 boundary markers already applied
   * to any tool-result content, so they're safe to feed back into a
   * subsequent `runAgentLoop` call as `initialMessages`.
   */
  onMessage?: (message: Message) => void;
  /**
   * Recursion depth (per ADR-003). Root chat sessions pass 0
   * (or omit). Subagent invocations pass `parentDepth + 1`. The
   * runAgentLoop function uses depth purely for diagnostic logging
   * and to confirm callers built the correct registry — the actual
   * depth-cap enforcement (depth ≤ 3) lives in the spawn_subagent
   * tool handler, which throws FC-6010 if asked to nest deeper.
   *
   * Defaults to 0. Valid values 0–3 (per ADR-003: depth-3 subagents
   * cannot spawn further; depth-4+ rejected at the spawn_subagent
   * registration site).
   */
  depth?: 0 | 1 | 2 | 3;
}

/**
 * Drive the agent loop. Yields `AgentEvent`s in order; consumers
 * iterate with `for await`. The generator returns when the loop ends
 * for any reason (assistant ended turn without tools, abort fired,
 * iteration cap hit, unrecoverable error).
 *
 * Pure-ish: the loop itself does no I/O. All I/O happens through the
 * provider (LLM stream) and the tool handlers (tool execution). The
 * loop's responsibilities are wiring, accounting, and event emission.
 */
export async function* runAgentLoop(opts: AgentLoopOptions): AsyncIterable<AgentEvent> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // Per-turn concurrency caps (ADR-002 + ADR-003): TOOL_CONCURRENCY
  // applies to all tool dispatches; SUBAGENT_CONCURRENCY nests inside
  // and applies only to spawn_subagent calls. Both are turn-scoped
  // because each turn awaits all dispatches before starting the next,
  // so per-turn concurrency caps equal per-parent caps.
  const limit = pLimit(TOOL_CONCURRENCY);
  const subagentLimit = pLimit(SUBAGENT_CONCURRENCY);
  const context: ToolHandlerContext = { sessionUuid: opts.sessionUuid };

  // Always have a defined AbortSignal so handlers can wire it
  // unconditionally. If the caller didn't supply one, this controller
  // is never aborted but is observable.
  const fallbackController = new AbortController();
  const abortSignal = opts.abortSignal ?? fallbackController.signal;

  // Working message history. The system prompt is the first message;
  // initialMessages follow.
  const messages: Message[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.initialMessages,
  ];

  let iteration = 0;

  while (true) {
    if (abortSignal.aborted) {
      yield { type: "turn-stop", stopReason: "aborted" };
      return;
    }

    if (iteration >= maxIterations) {
      const error = funClawError({
        code: "FC-6001",
        message: `Agent loop hit max iterations (${maxIterations}). Stopping. The conversation can be continued in a fresh session if needed.`,
        data: { iterationsSeen: iteration, maxIterations },
      });
      yield { type: "iteration-cap-hit", iterationsSeen: iteration, error };
      yield { type: "turn-stop", stopReason: "max_iterations" };
      return;
    }

    iteration += 1;
    yield { type: "turn-start", iteration };

    // Build the per-turn stream options. `tools` is a snapshot at this
    // turn — registries can theoretically grow between turns (MCP and
    // skill tools may be added dynamically), and re-reading each turn
    // ensures the LLM sees the current set.
    const streamOpts: StreamOptions = {
      messages,
      model: opts.model,
      tools: opts.registry.getDefinitions(),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      abortSignal,
    };

    let stopReason: StopReason = "end_turn";
    let usage: AgentUsage | undefined;
    const assistantContent: ContentBlock[] = [];
    let pendingText = "";
    let streamErrored = false;

    try {
      for await (const event of opts.provider.stream(streamOpts)) {
        if (abortSignal.aborted) {
          yield { type: "turn-stop", stopReason: "aborted" };
          return;
        }
        switch (event.type) {
          case "message-start": {
            // Optional model echo; not surfaced as an AgentEvent.
            break;
          }
          case "text-delta": {
            pendingText += event.text;
            yield { type: "text-delta", text: event.text };
            break;
          }
          case "text-stop": {
            if (pendingText.length > 0) {
              assistantContent.push({ type: "text", text: pendingText });
              pendingText = "";
            }
            break;
          }
          case "tool-use-start": {
            // Adapters emit this as soon as id+name are known, but the
            // input arrives complete on tool-use-stop. The agent loop
            // surfaces tool-call-start later (after dispatch begins) so
            // the call payload can include the parsed input.
            break;
          }
          case "tool-use-delta": {
            // Per ADR-002, spec-compliant adapters do not emit this;
            // included in the type union for completeness.
            break;
          }
          case "tool-use-stop": {
            assistantContent.push(event.toolUse);
            break;
          }
          case "message-stop": {
            stopReason = event.stopReason;
            if (event.usage !== undefined) {
              usage = {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              };
            }
            break;
          }
          case "error": {
            yield { type: "error", error: event.error };
            yield { type: "turn-stop", stopReason: "error" };
            streamErrored = true;
            return;
          }
        }
      }
    } catch (err) {
      // Distinguish "stream threw because the abort signal fired"
      // from "stream threw for another reason." Real provider
      // SDKs propagate AbortError out of the underlying fetch when
      // their abortSignal fires; we want that path classified as a
      // clean abort, not as an FC-9999 error. The signal-aborted
      // check is the most reliable disambiguator: if abortSignal is
      // aborted at the moment the throw arrived, the throw was
      // (almost certainly) caused by the abort.
      if (abortSignal.aborted) {
        yield { type: "turn-stop", stopReason: "aborted" };
        return;
      }
      const fcErr: FunClawError = isFunClawError(err)
        ? err
        : funClawError({
            code: "FC-9999",
            message: `Provider stream threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
      yield { type: "error", error: fcErr };
      yield { type: "turn-stop", stopReason: "error" };
      return;
    }

    if (streamErrored) {
      // Defensive: the case above already returned, but keep the
      // post-loop logic from running on a partially-built turn.
      return;
    }

    // Flush any text that arrived without a closing text-stop.
    if (pendingText.length > 0) {
      assistantContent.push({ type: "text", text: pendingText });
      pendingText = "";
    }

    const assistantMessage: Message = {
      role: "assistant",
      content: assistantContent,
    };
    messages.push(assistantMessage);
    opts.onMessage?.(assistantMessage);

    const toolUses: ToolUseBlock[] = assistantContent.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );

    if (stopReason !== "tool_use" || toolUses.length === 0) {
      yield {
        type: "turn-stop",
        stopReason,
        message: assistantMessage,
        ...(usage !== undefined ? { usage } : {}),
      };
      return;
    }

    // Parallel tool dispatch (ADR-002). Each handler resolves to a
    // `ToolResult`; thrown errors become `ToolResult { isError: true }`
    // at the dispatch boundary so siblings continue.
    const calls: ToolCall[] = toolUses.map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));

    for (const call of calls) {
      yield { type: "tool-call-start", call };
    }

    const dispatchPromises = calls.map((call) => {
      // ADR-003: spawn_subagent calls go through the nested 5-cap
      // before entering the broader 10-cap. The outer limit() still
      // counts the subagent call against TOOL_CONCURRENCY (one
      // spawn_subagent occupies one of the 10 outer slots) — the
      // inner subagentLimit() then ensures at most 5 subagents
      // execute concurrently.
      if (call.name === SPAWN_SUBAGENT_TOOL_NAME) {
        return limit(() =>
          subagentLimit(() => dispatchOne(call, context, abortSignal, opts.registry)),
        );
      }
      return limit(() => dispatchOne(call, context, abortSignal, opts.registry));
    });
    const results = await Promise.all(dispatchPromises);

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i] as ToolCall;
      const result = results[i] as ToolResult;
      yield { type: "tool-call-result", call, result };
    }

    if (abortSignal.aborted) {
      yield {
        type: "turn-stop",
        stopReason: "aborted",
        message: assistantMessage,
        ...(usage !== undefined ? { usage } : {}),
      };
      return;
    }

    // Wrap each result in ADR-001 boundary markers, build a single
    // user message containing all `tool_result` blocks (ADR-002
    // ordering: same order as the LLM's tool_use blocks so positional
    // and id-keyed correlation both work).
    const resultBlocks: ToolResultBlock[] = results.map((result, i) => {
      const call = calls[i] as ToolCall;
      const block: ToolResultBlock = {
        type: "tool_result",
        toolUseId: result.toolUseId,
        content: wrapBoundary({
          toolName: call.name,
          callId: call.id,
          sessionUuid: opts.sessionUuid,
          rawContent: result.content,
        }),
      };
      if (result.isError === true) block.isError = true;
      return block;
    });

    const userResultMessage: Message = {
      role: "user",
      content: resultBlocks,
    };
    messages.push(userResultMessage);
    opts.onMessage?.(userResultMessage);

    yield {
      type: "turn-stop",
      stopReason: "tool_use",
      message: assistantMessage,
      ...(usage !== undefined ? { usage } : {}),
    };

    // Loop body falls through to the next iteration.
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function dispatchOne(
  call: ToolCall,
  context: ToolHandlerContext,
  abortSignal: AbortSignal,
  registry: ToolRegistry,
): Promise<ToolResult> {
  const handler = registry.getHandler(call.name);
  if (handler === undefined) {
    return {
      toolUseId: call.id,
      content: `Tool "${call.name}" is not registered. Available tools: ${
        registry
          .getDefinitions()
          .map((d) => d.name)
          .join(", ") || "(none)"
      }. (FC-6003)`,
      isError: true,
    };
  }

  try {
    return await handler(call, context, abortSignal);
  } catch (err) {
    const message = isFunClawError(err)
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      toolUseId: call.id,
      content: `Tool "${call.name}" threw: ${message}. (FC-6002)`,
      isError: true,
    };
  }
}

interface BoundaryArgs {
  toolName: string;
  callId: string;
  sessionUuid: string;
  rawContent: string;
}

/**
 * Wrap raw tool output in ADR-001 boundary markers. The output is
 * placed verbatim between the opening and closing tags. The system
 * prompt instructs the LLM to treat content inside these tags as data,
 * not instructions, so we deliberately do NOT escape characters in the
 * raw content — escaping would corrupt legitimate tool output (logs
 * that contain `<` characters, etc.) and the system prompt is the
 * defense.
 */
function wrapBoundary(args: BoundaryArgs): string {
  const { toolName, callId, sessionUuid, rawContent } = args;
  return `<tool_result tool="${toolName}" id="${callId}" session="${sessionUuid}">\n${rawContent}\n</tool_result>`;
}
