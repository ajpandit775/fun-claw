// Fun Claw — Anthropic provider adapter.
//
// Wraps `@anthropic-ai/sdk`'s `messages.stream()` and emits Fun Claw-
// normalized `ProviderEvent`s. Tool IDs round-trip end-to-end per ADR-002:
// Anthropic's `tool_use.id` becomes our `ToolUseBlock.id` unchanged.
//
// Tool-use accumulation: Anthropic streams tool input as a sequence of
// `content_block_delta` events with `delta.type === "input_json_delta"`
// and `delta.partial_json: string`. The adapter accumulates these by
// content-block index, parses the assembled string with `JSON.parse` on
// the matching `content_block_stop`, and emits a single `tool-use-stop`
// with the parsed input as a complete `ToolUseBlock`.
//
// Reference docs:
//   - .claude/CLAUDE.md (FC-2xxx scoping rule, 2026-04-28)
//   - STACK.md "LLM providers" (Anthropic SDK ^0.90, messages.stream())
//   - docs/adr/ADR-002-tool-dispatch.md (tool IDs round-trip; AbortSignal)

import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../config.js";
import { funClawError } from "../errors.js";
import type {
  LLMProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderEvent,
  StreamOptions,
  UsageTokens,
} from "../provider.js";
import {
  providerAuthError,
  providerMalformedResponseError,
  providerRateLimitError,
  providerUnavailableError,
} from "../provider.js";
import type { ContentBlock, Message, StopReason, ToolUseBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const ANTHROPIC_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  imageInput: true,
  systemPrompt: "native",
});

// ---------------------------------------------------------------------------
// Minimal structural shapes for the SDK surface we depend on
// ---------------------------------------------------------------------------

/**
 * The minimum SDK surface our adapter calls. Production passes
 * `new Anthropic({...})` here; smoke tests pass a fake client object
 * with the same shape. Keeping this narrow keeps test setup small and
 * makes the SDK contract explicit in source.
 */
export interface AnthropicLike {
  messages: {
    stream(
      params: AnthropicStreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<RawAnthropicEvent>;
  };
}

interface AnthropicStreamParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Subset of `RawMessageStreamEvent` from the Anthropic SDK that this
 * adapter handles. Other event types (e.g., `ping`) are accepted by the
 * iterator but produce no Fun Claw event — see the default branch in
 * the switch.
 */
type RawAnthropicEvent =
  | {
      type: "message_start";
      message: {
        id: string;
        model: string;
        usage?: { input_tokens: number; output_tokens: number };
      };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string; stop_sequence?: string };
      usage?: { output_tokens: number };
    }
  | { type: "message_stop" };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface AnthropicProviderOptions {
  /** Anthropic API key. Required unless `client` is injected. */
  apiKey?: string;
  /** Override the default API base URL (rare). */
  baseURL?: string;
  /**
   * Inject a fake or pre-configured client. Used by smoke tests; production
   * paths leave this unset and pass `apiKey` instead.
   */
  client?: AnthropicLike;
}

export class AnthropicProvider implements LLMProvider {
  readonly name: Provider = "anthropic";
  readonly capabilities: ProviderCapabilities = ANTHROPIC_CAPABILITIES;
  private readonly client: AnthropicLike;

  constructor(opts: AnthropicProviderOptions) {
    if (opts.client !== undefined) {
      this.client = opts.client;
    } else if (opts.apiKey !== undefined && opts.apiKey !== "") {
      const init: { apiKey: string; baseURL?: string } = { apiKey: opts.apiKey };
      if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
      this.client = new Anthropic(init) as unknown as AnthropicLike;
    } else {
      throw funClawError({
        code: "FC-2001",
        message:
          "AnthropicProvider requires either `apiKey` or `client`. " +
          "Set ANTHROPIC_API_KEY in your environment, or supply a client for testing.",
        data: { provider: "anthropic" },
      });
    }
  }

  async *stream(opts: StreamOptions): AsyncIterable<ProviderEvent> {
    const params = translateRequest(opts);
    const sdkOptions: { signal?: AbortSignal } = {};
    if (opts.abortSignal !== undefined) sdkOptions.signal = opts.abortSignal;

    let stream: AsyncIterable<RawAnthropicEvent>;
    try {
      stream = this.client.messages.stream(params, sdkOptions);
    } catch (err) {
      throw mapErrorToFunClaw(err, opts.model);
    }

    // Per content-block index: track block kind plus accumulated state.
    type IndexState =
      | { kind: "text" }
      | { kind: "tool_use"; id: string; name: string; partial: string };
    const indexStates = new Map<number, IndexState>();

    let capturedStopReason: StopReason = "end_turn";
    let capturedUsage: UsageTokens | undefined;

    try {
      for await (const event of stream) {
        const baseRaw = opts._raw === true ? { _raw: event } : {};

        switch (event.type) {
          case "message_start": {
            const usage = event.message.usage;
            if (usage !== undefined) {
              capturedUsage = {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              };
            }
            yield {
              type: "message-start",
              ...(event.message.model !== undefined ? { model: event.message.model } : {}),
              ...baseRaw,
            };
            break;
          }

          case "content_block_start": {
            const cb = event.content_block;
            if (cb.type === "text") {
              indexStates.set(event.index, { kind: "text" });
              // No Fun Claw event yet — text-delta will follow.
            } else {
              indexStates.set(event.index, {
                kind: "tool_use",
                id: cb.id,
                name: cb.name,
                partial: "",
              });
              yield {
                type: "tool-use-start",
                id: cb.id,
                name: cb.name,
                ...baseRaw,
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text-delta", text: delta.text, ...baseRaw };
            } else {
              // input_json_delta — accumulate, do NOT yield (per ADR-002).
              const state = indexStates.get(event.index);
              if (state !== undefined && state.kind === "tool_use") {
                state.partial += delta.partial_json;
              }
            }
            break;
          }

          case "content_block_stop": {
            const state = indexStates.get(event.index);
            if (state === undefined) break;

            if (state.kind === "text") {
              yield { type: "text-stop", ...baseRaw };
            } else {
              let parsedInput: Record<string, unknown>;
              try {
                parsedInput =
                  state.partial.length > 0
                    ? (JSON.parse(state.partial) as Record<string, unknown>)
                    : {};
              } catch (parseErr) {
                throw providerMalformedResponseError({
                  provider: "anthropic",
                  model: opts.model,
                  detail: `tool_use input_json_delta parse failed for id ${state.id}`,
                  cause: parseErr,
                });
              }
              const toolUse: ToolUseBlock = {
                type: "tool_use",
                id: state.id,
                name: state.name,
                input: parsedInput,
              };
              yield { type: "tool-use-stop", toolUse, ...baseRaw };
            }
            indexStates.delete(event.index);
            break;
          }

          case "message_delta": {
            if (event.delta.stop_reason !== undefined) {
              capturedStopReason = mapAnthropicStopReason(event.delta.stop_reason);
            }
            if (event.usage !== undefined) {
              capturedUsage = {
                inputTokens: capturedUsage?.inputTokens ?? 0,
                outputTokens: event.usage.output_tokens,
              };
            }
            break;
          }

          case "message_stop": {
            yield {
              type: "message-stop",
              stopReason: capturedStopReason,
              ...(capturedUsage !== undefined ? { usage: capturedUsage } : {}),
              ...baseRaw,
            };
            break;
          }
        }
      }
    } catch (err) {
      // Mid-stream error: emit error event, then a terminal message-stop,
      // then re-throw so callers get a structured FunClawError.
      const fcErr = mapErrorToFunClaw(err, opts.model);
      yield { type: "error", error: fcErr };
      yield { type: "message-stop", stopReason: "error" };
      throw fcErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function translateRequest(opts: StreamOptions): AnthropicStreamParams {
  // Anthropic puts the system prompt at the top level, not in messages.
  const systemPieces: string[] = [];
  const nonSystem: Message[] = [];
  for (const msg of opts.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemPieces.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") systemPieces.push(block.text);
        }
      }
    } else {
      nonSystem.push(msg);
    }
  }
  const system = systemPieces.length > 0 ? systemPieces.join("\n\n") : undefined;

  const messages: AnthropicMessage[] = nonSystem.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: translateContent(msg.content),
  }));

  const tools: AnthropicTool[] | undefined =
    opts.tools !== undefined && opts.tools.length > 0
      ? opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }))
      : undefined;

  const params: AnthropicStreamParams = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
  };
  if (system !== undefined) params.system = system;
  if (tools !== undefined) params.tools = tools;
  return params;
}

function translateContent(content: string | ContentBlock[]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map<AnthropicContentBlock>((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    // tool_result
    return {
      type: "tool_result",
      tool_use_id: block.toolUseId,
      content: block.content,
      ...(block.isError === true ? { is_error: true } : {}),
    };
  });
}

function mapAnthropicStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "error";
  }
}

/**
 * Pull the `retry-after` header out of an Anthropic SDK error. The SDK
 * exposes headers as a Fetch-API `Headers` object in production, but we
 * accept either a `Headers` (with `.get()`) or a plain
 * `Record<string, string>` so smoke tests with hand-rolled errors don't
 * have to construct a real `Headers` instance.
 */
function parseRetryAfter(headers: unknown): number | undefined {
  if (headers === undefined || headers === null) return undefined;

  let raw: string | undefined;
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    const value = (headers as { get(key: string): string | null }).get("retry-after");
    raw = value === null ? undefined : value;
  } else if (typeof headers === "object") {
    const obj = headers as Record<string, string>;
    raw = obj["retry-after"] ?? obj["Retry-After"];
  }

  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Map any error from the Anthropic SDK call into a `ProviderError`.
 * `Anthropic.APIError` instances are mapped by status code; everything
 * else falls back to `FC-2006` (malformed response).
 *
 * Errors that are already `FunClawError` (e.g., a
 * `providerMalformedResponseError` thrown from inside our own parsing)
 * pass through unchanged.
 */
function mapErrorToFunClaw(err: unknown, model: string): ProviderError {
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("FC-2")
  ) {
    return err as ProviderError;
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const ctx = { provider: "anthropic", model, cause: err };
    if (status === 401) {
      return providerAuthError(ctx);
    }
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers);
      const rateCtx: {
        provider: string;
        model: string;
        cause: unknown;
        retryAfterSeconds?: number;
      } = { ...ctx };
      if (retryAfter !== undefined) rateCtx.retryAfterSeconds = retryAfter;
      return providerRateLimitError(rateCtx);
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      return providerUnavailableError(ctx);
    }
  }

  return providerMalformedResponseError({
    provider: "anthropic",
    model,
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}
