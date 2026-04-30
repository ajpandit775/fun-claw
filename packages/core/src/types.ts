// Fun Claw core types.
//
// Pure types module. No I/O, no runtime dependencies, no imports. Everything
// in this file is consumed at compile time. Anything that needs a runtime
// value (constants, validators, factory functions) belongs in a sibling
// module, not here.
//
// Reference docs:
//   - .claude/CLAUDE.md ("Error handling contract", error-code namespaces)
//   - REQUIREMENTS.md (Flow 2 chat loop, Flow 4 MCP tools, Flow 5 subagents)
//   - docs/adr/ADR-001-trust-boundaries.md (LLM is semi-trusted; tool-result
//     content is adversarial input on the next turn)
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch, tool IDs MUST
//     round-trip end-to-end so results correlate by id, not by position)
//   - docs/adr/ADR-003-subagent-isolation.md (subagent budgets; future types
//     for subagent results land in a later slice)

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

/**
 * The speaker role of a conversation message.
 *
 * Provider notes (the adapters normalize each):
 *   - Anthropic: maps directly.
 *   - OpenAI: tool results normally arrive as `role: "tool"`. The adapter
 *     translates those into our internal `role: "user"` message containing
 *     one or more `ToolResultBlock`s (per ADR-002).
 *   - Gemini: parts-based, similar concept; the adapter normalizes.
 */
export type Role = "system" | "user" | "assistant";

/**
 * A turn-stop reason returned by the LLM. Normalized across providers.
 *
 *   - "end_turn":       the model finished and is awaiting the next user turn.
 *   - "tool_use":       the model emitted at least one tool call and is waiting
 *                       for results. Per ADR-002 the agent loop dispatches the
 *                       calls in parallel and feeds the gathered results back
 *                       as a new user message.
 *   - "max_tokens":     the response was cut off at the per-turn token limit.
 *   - "stop_sequence":  a configured stop sequence was matched.
 *   - "content_filter": the provider's safety filter intervened.
 *   - "error":          the response could not be parsed or stopped abnormally.
 */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "error";

// ---------------------------------------------------------------------------
// Content blocks (the discriminated union that lives inside a Message)
// ---------------------------------------------------------------------------

/** Plain text inside an assistant or user message. */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * A tool call emitted by the assistant.
 *
 * `id` is the provider-assigned identifier (Anthropic `tool_use.id`,
 * OpenAI `tool_call.id`, Gemini `functionCall.id`) and MUST round-trip
 * unchanged through the dispatcher so the matching `ToolResultBlock.toolUseId`
 * correlates by id, not by position (ADR-002).
 *
 * `input` is a JSON-serializable object whose shape is described by the
 * registered tool's `ToolDefinition.inputSchema`.
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The result of a tool call, sent back to the assistant in a subsequent user
 * message.
 *
 * Per ADR-002, when a tool throws, the throw is caught at the dispatch
 * boundary and converted into a `ToolResultBlock` with `isError: true` —
 * exceptions never propagate up to the agent loop.
 *
 * Per ADR-001, `content` is adversarial on the next turn (it could carry
 * prompt-injection payloads from a tool's stdout, an MCP server, or web
 * content). The agent loop's serializer wraps it in explicit boundary
 * markers (e.g. `<tool_result name="..." server="...">…</tool_result>`)
 * before it reaches the LLM context.
 */
export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** A single content block inside a Message. Discriminated by `type`. */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * One conversation turn. The agent loop's `messages` array holds these in
 * order: system, user, assistant, user, assistant, …
 *
 * `content` is either a plain string (the simple text-only case) or an array
 * of `ContentBlock`s (assistant turns with tool calls, user turns carrying
 * tool results, future multimodal). The provider adapters translate to
 * and from each provider's wire shape.
 */
export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

// ---------------------------------------------------------------------------
// Tools — definition, dispatchable call, dispatch result
// ---------------------------------------------------------------------------

/**
 * A JSON Schema fragment describing a tool's input parameters. Deliberately
 * loose so each provider can pass through whatever schema dialect it accepts;
 * validation lives at the provider adapter boundary, not in the type system.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * The static description of a tool, registered with the agent loop and
 * forwarded to the LLM as part of the request.
 *
 * `name` may be:
 *   - a built-in tool (e.g. `execute_bash`, `write_file`, `spawn_subagent`)
 *   - an MCP-namespaced tool (`mcp__<server>__<tool>`)
 *   - a skill script (resolved via `read_skill` / `run_skill_script`)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * A tool call extracted from an assistant message and ready for dispatch.
 *
 * Structurally identical to `ToolUseBlock` minus the `type` discriminator.
 * The separate name communicates intent: once a `ToolUseBlock` has been
 * pulled out of a message for execution, it is a `ToolCall`.
 *
 * Per ADR-002, `id` MUST round-trip end-to-end so the resulting
 * `ToolResult.toolUseId` correlates by id.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The result of executing a `ToolCall`. The dispatcher converts each
 * `ToolResult` into a `ToolResultBlock` and gathers all blocks for a turn
 * into a single user message before sending back to the LLM (ADR-002).
 *
 * `isError` is `true` when the tool failed. Per ADR-002 the agent loop never
 * aborts on a single tool failure — siblings continue, the LLM sees the error
 * result and decides whether to retry or route around.
 */
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Three-digit suffix for a `FunClawErrorCode`. Compile-time guard so codes
 * cannot drift to "FC-1A" or "FC-12" by accident.
 */
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type ThreeDigits = `${Digit}${Digit}${Digit}`;

/**
 * Structured error-code namespace, in the form FC-Nxxx where N selects the
 * top-level component and xxx is a 3-digit identifier within that component.
 *
 * Per CLAUDE.md "Error handling contract":
 *   - FC-1xxx — Docker errors (daemon unreachable, container failed to start,
 *               container OOM-killed)
 *   - FC-2xxx — LLM provider errors (auth failure, rate limit, malformed
 *               response)
 *   - FC-3xxx — MCP errors (server crashed, transport failure, malformed
 *               JSON-RPC)
 *   - FC-4xxx — Skill errors (frontmatter invalid, name conflict, script
 *               execution failed)
 *   - FC-5xxx — Filesystem errors (config unreadable, state file lock
 *               contention)
 *   - FC-6xxx — Agent loop errors (max iterations, malformed tool call,
 *               subagent budget exceeded)
 *   - FC-9xxx — Unexpected / unclassified internal errors. Reserved for
 *               wrapping non-FunClawError throws that bubble up to the
 *               top-level error handler. The canonical code is FC-9999;
 *               more specific codes are out of scope by design — if an
 *               error mode is common enough to deserve a code, it
 *               belongs in one of the component namespaces above.
 *
 * Every code that appears in source MUST also appear in
 * `docs/troubleshooting.md` with its message, cause, and fix.
 *
 * This is a tightening of CLAUDE.md's `code: string` so the compiler
 * rejects malformed codes. The runtime shape is unchanged.
 */
export type FunClawErrorCode =
  | `FC-1${ThreeDigits}`
  | `FC-2${ThreeDigits}`
  | `FC-3${ThreeDigits}`
  | `FC-4${ThreeDigits}`
  | `FC-5${ThreeDigits}`
  | `FC-6${ThreeDigits}`
  | `FC-9${ThreeDigits}`;

/**
 * The canonical structured error shape used everywhere in Fun Claw.
 *
 * Per CLAUDE.md "Error handling contract": errors propagate via thrown
 * exceptions inside packages, but cross the agent-loop boundary as
 * `ToolResultBlock` with `isError: true` so the LLM sees a structured error
 * rather than the loop crashing.
 *
 * Per CLAUDE.md "Never log secrets": if you add a field to `data` that may
 * carry a secret, also add the path to the pino redaction list in
 * `packages/core/logger.ts`.
 */
export interface FunClawError {
  /** Machine-readable code, e.g. `"FC-1003"`. */
  code: FunClawErrorCode;
  /** Human-readable message. Safe to print to stderr; never include secrets. */
  message: string;
  /** Original error if this wraps another. Typed as `unknown` to discourage
   *  assuming it is an `Error` instance — providers throw all sorts of things. */
  cause?: unknown;
  /** Structured context for debugging. Never include secrets. Goes to the log
   *  file (with pino redaction applied), not to stderr. */
  data?: object;
}

// ---------------------------------------------------------------------------
// Agent loop primitives
// ---------------------------------------------------------------------------

/**
 * Token usage reported by the LLM at turn end. Mirrors `UsageTokens` in
 * `provider.ts`; duplicated here to keep `types.ts` standalone (no
 * cross-module imports).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why the agent loop ended a turn. Extends the provider-side `StopReason`
 * with two loop-specific values:
 *
 *   - `"aborted"` — the caller's `AbortSignal` fired (Ctrl-C in the TUI).
 *   - `"max_iterations"` — the iteration cap was reached (FC-6001).
 *
 * Other values are forwarded from the provider's `StopReason` unchanged.
 */
export type AgentStopReason = StopReason | "aborted" | "max_iterations";

/**
 * Context passed to every `ToolHandler` invocation. Minimal by design
 * — only the session UUID, useful for log correlation and for tools
 * that want to embed it in their output. Extend the shape with
 * additional dependencies as new tool categories are added.
 */
export interface ToolHandlerContext {
  /** UUID of the current chat session. Stable across all tool calls in
   *  one `runAgentLoop` invocation. */
  sessionUuid: string;
}

/**
 * The function each registered tool implements. Per ADR-002, throws are
 * caught at the dispatch boundary and converted to a `ToolResult` with
 * `isError: true` — handlers MAY throw freely; the loop never propagates
 * a tool throw upward.
 *
 * The handler receives an `AbortSignal` threaded from the loop's caller
 * (the chat command's `AbortController`). Long-running handlers should
 * observe it and bail cleanly when fired.
 */
export type ToolHandler = (
  toolCall: ToolCall,
  context: ToolHandlerContext,
  abortSignal: AbortSignal,
) => Promise<ToolResult>;

/**
 * Discriminated union of events the agent loop yields. Consumers
 * (the chat command's TUI, smoke tests, future automation) iterate the
 * loop's async generator and dispatch on `type`.
 *
 * Lifecycle within one `runAgentLoop` call:
 *   1. `turn-start` (iteration 1)
 *   2. `text-delta` events as the LLM streams text
 *   3. `tool-call-start` for each tool call after the LLM emits them
 *   4. `tool-call-result` for each tool call as it completes (parallel
 *       dispatch per ADR-002 means completion order is not call order;
 *       the result event includes the original `call` so consumers can
 *       correlate by id)
 *   5. `turn-stop` with the resolved `stopReason`
 *   6. If `stopReason === "tool_use"`, the loop continues with the next
 *      iteration (turn-start, text-delta, ...). Otherwise, the generator
 *      returns.
 *
 * `iteration-cap-hit` and `error` are terminal — the loop emits them
 * then a final `turn-stop` and returns.
 */
export type AgentEvent =
  | {
      type: "turn-start";
      /** 1-based iteration counter; resets per `runAgentLoop` call. */
      iteration: number;
    }
  | {
      type: "text-delta";
      /** A chunk of assistant text forwarded from the provider stream. */
      text: string;
    }
  | {
      type: "tool-call-start";
      /** The tool call being dispatched. Per ADR-002, `call.id`
       *  round-trips end-to-end. */
      call: ToolCall;
    }
  | {
      type: "tool-call-result";
      /** The original call for correlation. */
      call: ToolCall;
      /** The dispatcher's result (per ADR-002, errors are conveyed via
       *  `result.isError === true`, not by throwing). */
      result: ToolResult;
    }
  | {
      type: "turn-stop";
      stopReason: AgentStopReason;
      /** The complete assistant message produced this turn, when one
       *  exists. Absent when the loop short-circuits before any
       *  message (e.g., abort fires before the provider stream starts). */
      message?: Message;
      /** Token usage if the provider reported it. */
      usage?: AgentUsage;
    }
  | {
      type: "iteration-cap-hit";
      /** Iteration count at the moment the cap was hit. */
      iterationsSeen: number;
      /** Always `FC-6001`. Carried as `FunClawError` for uniform error
       *  handling at consumer sites. */
      error: FunClawError;
    }
  | {
      type: "error";
      /** Any unrecoverable agent-loop error: a provider stream that
       *  throws, an internal bug wrapped as `FC-9999`, etc. Tool errors
       *  do NOT surface here per ADR-002 — they become `ToolResult`s
       *  with `isError: true`. */
      error: FunClawError;
    };
