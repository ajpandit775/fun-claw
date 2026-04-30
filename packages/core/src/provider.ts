// Fun Claw LLM provider abstraction.
//
// This module is the contract every provider adapter implements
// (`AnthropicProvider`, `OpenAIProvider`, `GeminiProvider`). It owns:
//
//   1. The `LLMProvider` interface — the single shape the agent loop and
//      dispatcher consume. Adapters wrap each provider's native SDK and
//      emit Fun Claw-normalized events behind this interface.
//   2. The `ProviderEvent` discriminated union — eight variants describing
//      every state of a streaming response. Tool-use deltas exist in the
//      type union for completeness but spec-compliant adapters accumulate
//      input fragments internally and emit only the assembled
//      `tool-use-stop` per ADR-002 (the dispatcher needs complete
//      `ToolUseBlock`s to dispatch in parallel via `Promise.all`).
//   3. The `ProviderCapabilities` shape — a small, fixed-field object
//      describing what the provider can do. The agent loop reads it at
//      startup and refuses to run if a required capability is missing.
//   4. The `ProviderError` type plus four helper factories covering the
//      four common wire-side failure modes (auth, rate limit, malformed
//      response, provider unavailable). All four map to FC-2xxx codes
//      whose entries live in `docs/troubleshooting.md`.
//
// Reference docs:
//   - .claude/CLAUDE.md "Error handling contract"; FC-2xxx scoping rule
//     (host-side vs wire-side, dated 2026-04-28).
//   - STACK.md "LLM providers" (the three pinned SDKs and the rationale
//     for forbidding Vercel AI SDK / LangChain — they hide useful
//     provider-specific features that the `_raw` escape hatch preserves).
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch, IDs round-trip
//     end-to-end, AbortSignal cancellation).
//   - REQUIREMENTS.md "Hard constraints" (must support all four providers
//     from v1; Anthropic, OpenAI, Gemini, OpenAI-compatible).
//
// The `_raw` field on events is the explicit escape hatch STACK.md's "must
// not hide useful provider-specific features" rule requires. Underscore
// prefix signals "internal, non-portable, use at your own risk" — the
// agent loop and TUI ignore it; consumers that need provider-specific
// features (Anthropic system fingerprints, OpenAI logprobs, Gemini safety
// ratings) read it.

import type { Provider } from "./config.js";
import { funClawError } from "./errors.js";
import type { FunClawError, Message, StopReason, ToolDefinition, ToolUseBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Static capability description of a provider adapter. The agent loop
 * reads `capabilities` at startup and refuses to run if a required
 * capability is missing (e.g., a provider with `tools: false` cannot back
 * a session that needs to call `execute_bash`).
 *
 * The shape is deliberately small. Add a field only when a genuine need
 * surfaces — STACK.md's rationale for forbidding Vercel AI SDK is that
 * abstraction layers grow until they hide useful features; this object
 * avoids that drift by keeping the surface minimal and the `_raw` escape
 * hatch on every event handling the rare case.
 *
 * `systemPrompt`:
 *   - `"native"` — the provider has a dedicated `system` field at the top
 *     level of the request (Anthropic, Gemini's `systemInstruction`).
 *   - `"as-message"` — the provider expects the system prompt to ride
 *     along as a message with `role: "system"` (OpenAI chat-completions).
 *   - `false` — the provider does not support system prompts.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  imageInput: boolean;
  systemPrompt: "native" | "as-message" | false;
}

// ---------------------------------------------------------------------------
// Stream options
// ---------------------------------------------------------------------------

/**
 * Inputs to a single streaming call. The agent loop assembles one
 * `StreamOptions` per turn from the conversation state, the registered
 * tool definitions, the configured model, and the per-session
 * `AbortController`.
 */
export interface StreamOptions {
  /**
   * Conversation history in Fun Claw's canonical shape. The adapter
   * translates to the provider's wire format on the way out.
   */
  messages: Message[];

  /**
   * Model identifier passed through to the provider unchanged. The
   * adapter does not validate or normalize model names; the user's config
   * decides which model to call and Fun Claw forwards it.
   */
  model: string;

  /**
   * Tool definitions available for the model to call. Empty / omitted
   * means "no tools" (the agent loop can still produce a text-only
   * response). Per ADR-002, IDs the model assigns to tool calls round-
   * trip end-to-end; nothing here re-keys them.
   */
  tools?: ToolDefinition[];

  /** Maximum tokens the response can occupy. Provider-specific defaults
   *  apply if omitted. */
  maxTokens?: number;

  /**
   * Cancellation signal threaded from the agent loop's `AbortController`.
   * Per ADR-002, Ctrl-C in the TUI fires this signal to cancel both the
   * in-flight LLM stream and any in-flight tool executions.
   */
  abortSignal?: AbortSignal;

  /**
   * When true, each emitted `ProviderEvent` populates `_raw` with the
   * underlying SDK event object. Default false; populating raw events on
   * every chunk has overhead even if the consumer ignores them.
   */
  _raw?: boolean;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token usage reported by the provider on the terminal `message-stop`
 * event. Optional because not every provider reports usage on every stop
 * (or reports it before the stream completes).
 */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// ProviderEvent — eight-variant discriminated union
// ---------------------------------------------------------------------------

/**
 * Internal: every event carries an optional `_raw` field for the SDK
 * escape hatch. Underscore-prefix is the deliberate "internal, non-
 * portable" signal — agent loop and TUI ignore it.
 */
interface BaseEvent {
  _raw?: unknown;
}

/** The response is beginning. Optional model echo if the SDK reports it. */
export interface MessageStartEvent extends BaseEvent {
  type: "message-start";
  model?: string;
}

/**
 * A chunk of assistant text. Fired as the SDK yields each token-or-so
 * fragment so the TUI can stream characters live. Aggregating a complete
 * text block is the consumer's job; the adapter does not buffer.
 */
export interface TextDeltaEvent extends BaseEvent {
  type: "text-delta";
  text: string;
}

/** The current text block is complete (the assistant moved on to a tool
 *  call, finished the turn, or the stream closed mid-text). */
export interface TextStopEvent extends BaseEvent {
  type: "text-stop";
}

/**
 * The assistant is calling a tool. `id` is the provider-assigned
 * identifier and MUST round-trip end-to-end per ADR-002. `name` is the
 * tool name. Input is empty at this point — adapters accumulate the
 * input JSON fragments internally and emit a single `tool-use-stop` with
 * the assembled, parsed input.
 */
export interface ToolUseStartEvent extends BaseEvent {
  type: "tool-use-start";
  id: string;
  name: string;
}

/**
 * A JSON fragment of the tool's input arguments.
 *
 * **Spec-compliant adapters do NOT emit this variant.** It exists in the
 * type union for completeness — adapters accumulate input fragments
 * internally (keyed by `id`) and emit only the assembled `tool-use-stop`.
 *
 * Per ADR-002, the agent loop needs complete `ToolUseBlock`s to dispatch
 * in parallel via `Promise.all`, not partial JSON. Forcing every consumer
 * to do JSON-fragment assembly is the wrong layering. The variant is
 * preserved in the union so a future adapter that wants to expose deltas
 * (e.g., for a TUI showing partial tool args being typed) can do so
 * without changing the type contract.
 */
export interface ToolUseDeltaEvent extends BaseEvent {
  type: "tool-use-delta";
  id: string;
  inputFragment: string;
}

/**
 * A tool call is complete. `toolUse` is the full `ToolUseBlock` with
 * parsed input — ready for the dispatcher to fire via `Promise.all`
 * (ADR-002).
 */
export interface ToolUseStopEvent extends BaseEvent {
  type: "tool-use-stop";
  toolUse: ToolUseBlock;
}

/**
 * The response is complete. `stopReason` is normalized across providers
 * (see `StopReason` in types.ts). `usage` is provider-reported token
 * counts when available.
 */
export interface MessageStopEvent extends BaseEvent {
  type: "message-stop";
  stopReason: StopReason;
  usage?: UsageTokens;
}

/**
 * A recoverable error occurred mid-stream. Payload carries a structured
 * `FunClawError` (typically a `ProviderError`). Emitting this variant
 * does NOT itself terminate the stream — adapters may follow it with a
 * `message-stop { stopReason: "error" }` to make termination explicit.
 *
 * Unrecoverable failures (auth, rate limit at request open) are thrown
 * synchronously from `stream()` rather than emitted as events, so the
 * caller's `for await` loop never starts.
 */
export interface ProviderErrorEvent extends BaseEvent {
  type: "error";
  error: FunClawError;
}

/**
 * Eight-variant discriminated union covering every state of a streaming
 * response. Discriminator: `type`.
 */
export type ProviderEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | TextStopEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseStopEvent
  | MessageStopEvent
  | ProviderErrorEvent;

// ---------------------------------------------------------------------------
// LLMProvider interface
// ---------------------------------------------------------------------------

/**
 * The contract every provider adapter implements. Adapters live in
 * `packages/core/src/provider/<name>.ts` and wrap each provider's native
 * SDK. The factory in `packages/core/src/provider/index.ts` constructs
 * the right adapter from `config.provider` plus the resolved API key
 * from `getSecret`.
 */
export interface LLMProvider {
  /**
   * Provider identifier matching the `Provider` enum from `config.ts`.
   * The factory uses this when building diagnostic messages; the agent
   * loop does not inspect it during normal operation.
   */
  readonly name: Provider;

  /**
   * Static capabilities. Set once at construction (typically a frozen
   * module-level constant assigned to the instance). The agent loop
   * reads this at session start.
   */
  readonly capabilities: ProviderCapabilities;

  /**
   * Stream a response from the provider. Consumers iterate with
   * `for await (const event of provider.stream(opts))`. Cancellation is
   * via `opts.abortSignal`; aborting cleanly stops the SDK's underlying
   * fetch and ends the iterator.
   */
  stream(opts: StreamOptions): AsyncIterable<ProviderEvent>;
}

// ---------------------------------------------------------------------------
// ProviderError + helpers
// ---------------------------------------------------------------------------

/**
 * Codes emitted by provider adapters. A narrow specialization of
 * `FunClawErrorCode` covering only the wire-side FC-2xxx provider
 * responses. Host-side key-loading failures (FC-2001 / FC-2002 / FC-2003)
 * live in `config.ts` / `getSecret` and are documented separately.
 */
export type ProviderErrorCode = "FC-2004" | "FC-2005" | "FC-2006" | "FC-2007";

/**
 * A `FunClawError` thrown from a provider adapter. The runtime instance
 * is `Error & FunClawError` (per the `funClawError` factory in
 * `errors.ts`); the type narrows `code` to the provider-error subset
 * defined above.
 */
export type ProviderError = Error & FunClawError & { code: ProviderErrorCode };

/**
 * Common context every helper needs. `provider` and `model` are required
 * because the maintainer's 2026-04-28 refinement specifies error messages
 * include both — users with multiple providers / keys need to know which
 * credential and which model triggered the failure.
 */
export interface ProviderErrorContext {
  /** Provider name, e.g. `"anthropic"`, `"openai"`. */
  provider: string;
  /** Model the request was targeting at failure time. */
  model: string;
  /** Original underlying error. Preserved on `cause` for log inspection. */
  cause?: unknown;
}

/** Rate-limit context adds an optional retry hint parsed from the
 *  provider's `Retry-After` header when present. */
export interface RateLimitErrorContext extends ProviderErrorContext {
  retryAfterSeconds?: number;
}

/** Malformed-response context allows an optional short detail string for
 *  the failure (e.g., `"input_json_delta JSON parse failed"`). */
export interface MalformedResponseErrorContext extends ProviderErrorContext {
  detail?: string;
}

/**
 * FC-2007 — provider rejected the API key (HTTP 401).
 *
 * Per the maintainer's 2026-04-28 refinement, the message includes the
 * provider name and the requested model so users with multiple keys know
 * which credential to inspect. Per-provider remediation (Anthropic
 * workspace, OpenAI project, Gemini API enablement) lives in
 * `docs/troubleshooting.md` under FC-2007.
 */
export function providerAuthError(ctx: ProviderErrorContext): ProviderError {
  return funClawError({
    code: "FC-2007",
    message: `Provider ${ctx.provider} rejected the API key when calling ${ctx.model}. The key may be invalid, expired, or lack permissions for this model.`,
    cause: ctx.cause,
    data: { provider: ctx.provider, model: ctx.model },
  }) as ProviderError;
}

/**
 * FC-2004 — provider rate limited the request (HTTP 429).
 *
 * If `retryAfterSeconds` is provided (parsed from the `Retry-After`
 * header), the message includes a retry hint. Fun Claw does NOT auto-
 * retry; the agent loop surfaces the error to the user.
 */
export function providerRateLimitError(ctx: RateLimitErrorContext): ProviderError {
  const retryHint =
    ctx.retryAfterSeconds !== undefined ? ` Retry after ${ctx.retryAfterSeconds}s.` : "";
  return funClawError({
    code: "FC-2004",
    message: `Provider ${ctx.provider} rate-limited the request to ${ctx.model}.${retryHint}`,
    cause: ctx.cause,
    data: {
      provider: ctx.provider,
      model: ctx.model,
      retryAfterSeconds: ctx.retryAfterSeconds,
    },
  }) as ProviderError;
}

/** FC-2005 — provider unavailable (HTTP 500-503). */
export function providerUnavailableError(ctx: ProviderErrorContext): ProviderError {
  return funClawError({
    code: "FC-2005",
    message: `Provider ${ctx.provider} is currently unavailable while calling ${ctx.model}. Try again in a moment.`,
    cause: ctx.cause,
    data: { provider: ctx.provider, model: ctx.model },
  }) as ProviderError;
}

/**
 * FC-2006 — provider returned a malformed response.
 *
 * Used when the SDK's stream emits something the adapter cannot
 * normalize: an unexpected event shape, a JSON parse failure during
 * tool-use accumulation, or a truncated event stream. The `detail` field
 * on the context lets adapters add a short note about which step
 * failed; it surfaces in the error message and `data` for log
 * inspection.
 */
export function providerMalformedResponseError(ctx: MalformedResponseErrorContext): ProviderError {
  const detail = ctx.detail !== undefined ? ` (${ctx.detail})` : "";
  return funClawError({
    code: "FC-2006",
    message: `Provider ${ctx.provider} returned a malformed response while calling ${ctx.model}${detail}.`,
    cause: ctx.cause,
    data: { provider: ctx.provider, model: ctx.model, detail: ctx.detail },
  }) as ProviderError;
}
