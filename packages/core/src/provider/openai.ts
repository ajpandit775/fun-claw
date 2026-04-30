// Fun Claw — OpenAI provider adapter.
//
// Wraps `openai` SDK's `chat.completions.create({ stream: true })`. Uses
// the chat-completions endpoint (NOT the newer Responses API) because
// chat-completions is the broader provider-compatible surface — Together,
// Groq, OpenRouter, Ollama all speak it. The same code path serves the
// `openai` and `openai-compatible` providers; the latter just supplies a
// `baseURL` override.
//
// Tool-use accumulation: OpenAI streams tool calls as a partial array on
// each chunk's `delta.tool_calls`. Each entry is keyed by `index`; `id`
// and `function.name` arrive on the first chunk for that index;
// subsequent chunks append to `function.arguments` (a string). The
// adapter accumulates by index and parses arguments on
// `finish_reason: "tool_calls"`, emitting one `tool-use-stop` per
// completed tool call.
//
// Reference docs:
//   - .claude/CLAUDE.md (FC-2xxx scoping rule, 2026-04-28)
//   - STACK.md "LLM providers" (openai ^5; baseURL override drives
//     openai-compatible)
//   - docs/adr/ADR-002-tool-dispatch.md

import OpenAI from "openai";
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

const OPENAI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  imageInput: true,
  systemPrompt: "as-message",
});

// ---------------------------------------------------------------------------
// Minimal SDK shape we depend on
// ---------------------------------------------------------------------------

export interface OpenAILike {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionsParams & { stream: true },
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<RawOpenAIChunk>>;
    };
  };
}

interface OpenAIChatCompletionsParams {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  tools?: OpenAITool[];
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface RawOpenAIChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  /** API key. Required unless `client` is injected. */
  apiKey?: string;
  /** Override the default OpenAI endpoint. Drives openai-compatible
   *  providers (Together, Groq, OpenRouter, Ollama). */
  baseURL?: string;
  /** Inject a fake / pre-configured client for testing. */
  client?: OpenAILike;
  /**
   * Override the `name` reported on the LLMProvider instance. Defaults
   * to `"openai"`. The factory sets this to `"openai-compatible"` when
   * constructed with a `baseURL` pointing at a non-OpenAI compatible
   * endpoint, so logs and diagnostics distinguish them.
   */
  name?: Provider;
}

export class OpenAIProvider implements LLMProvider {
  readonly name: Provider;
  readonly capabilities: ProviderCapabilities = OPENAI_CAPABILITIES;
  private readonly client: OpenAILike;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.name = opts.name ?? "openai";
    if (opts.client !== undefined) {
      this.client = opts.client;
    } else if (opts.apiKey !== undefined && opts.apiKey !== "") {
      const init: { apiKey: string; baseURL?: string } = {
        apiKey: opts.apiKey,
      };
      if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
      this.client = new OpenAI(init) as unknown as OpenAILike;
    } else {
      throw funClawError({
        code: "FC-2001",
        message:
          "OpenAIProvider requires either `apiKey` or `client`. " +
          "Set OPENAI_API_KEY in your environment, or supply a client for testing.",
        data: { provider: this.name },
      });
    }
  }

  async *stream(opts: StreamOptions): AsyncIterable<ProviderEvent> {
    const params = translateRequest(opts);
    const sdkOptions: { signal?: AbortSignal } = {};
    if (opts.abortSignal !== undefined) sdkOptions.signal = opts.abortSignal;

    let stream: AsyncIterable<RawOpenAIChunk>;
    try {
      stream = await this.client.chat.completions.create({ ...params, stream: true }, sdkOptions);
    } catch (err) {
      throw mapErrorToFunClaw(err, opts.model, this.name);
    }

    type ToolState = { id: string; name: string; arguments: string };
    const toolsByIndex = new Map<number, ToolState>();
    const startedTools = new Set<number>();

    let textOpen = false;
    let capturedStopReason: StopReason = "end_turn";
    let capturedUsage: UsageTokens | undefined;
    let modelEmitted = false;

    try {
      for await (const chunk of stream) {
        const baseRaw = opts._raw === true ? { _raw: chunk } : {};

        if (!modelEmitted) {
          yield {
            type: "message-start",
            model: chunk.model,
            ...baseRaw,
          };
          modelEmitted = true;
        }

        for (const choice of chunk.choices) {
          const delta = choice.delta;

          if (typeof delta.content === "string" && delta.content.length > 0) {
            if (!textOpen) textOpen = true;
            yield { type: "text-delta", text: delta.content, ...baseRaw };
          }

          if (delta.tool_calls !== undefined) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              let state = toolsByIndex.get(idx);
              if (state === undefined) {
                state = { id: "", name: "", arguments: "" };
                toolsByIndex.set(idx, state);
              }
              if (tc.id !== undefined && state.id === "") state.id = tc.id;
              if (tc.function?.name !== undefined && state.name === "") {
                state.name = tc.function.name;
              }
              if (tc.function?.arguments !== undefined) {
                state.arguments += tc.function.arguments;
              }

              if (!startedTools.has(idx) && state.id !== "" && state.name !== "") {
                startedTools.add(idx);
                yield {
                  type: "tool-use-start",
                  id: state.id,
                  name: state.name,
                  ...baseRaw,
                };
              }
            }
          }

          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (textOpen) {
              yield { type: "text-stop", ...baseRaw };
              textOpen = false;
            }

            if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
              const indexes = [...toolsByIndex.keys()].sort((a, b) => a - b);
              for (const idx of indexes) {
                const state = toolsByIndex.get(idx);
                if (state === undefined) continue;
                let parsedInput: Record<string, unknown>;
                try {
                  parsedInput =
                    state.arguments.length > 0
                      ? (JSON.parse(state.arguments) as Record<string, unknown>)
                      : {};
                } catch (parseErr) {
                  throw providerMalformedResponseError({
                    provider: this.name,
                    model: opts.model,
                    detail: `tool_calls[${idx}] arguments JSON parse failed for id ${state.id}`,
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
            }

            capturedStopReason = mapOpenAIStopReason(choice.finish_reason);
          }
        }

        if (chunk.usage !== undefined) {
          capturedUsage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      yield {
        type: "message-stop",
        stopReason: capturedStopReason,
        ...(capturedUsage !== undefined ? { usage: capturedUsage } : {}),
      };
    } catch (err) {
      const fcErr = mapErrorToFunClaw(err, opts.model, this.name);
      yield { type: "error", error: fcErr };
      yield { type: "message-stop", stopReason: "error" };
      throw fcErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function translateRequest(opts: StreamOptions): OpenAIChatCompletionsParams {
  const messages: OpenAIMessage[] = [];
  for (const msg of opts.messages) {
    pushTranslatedMessage(messages, msg);
  }

  const tools: OpenAITool[] | undefined =
    opts.tools !== undefined && opts.tools.length > 0
      ? opts.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : undefined;

  const params: OpenAIChatCompletionsParams = {
    model: opts.model,
    messages,
  };
  if (opts.maxTokens !== undefined) params.max_tokens = opts.maxTokens;
  if (tools !== undefined) params.tools = tools;
  return params;
}

/**
 * Translate one Fun Claw `Message` into one or more OpenAI chat-
 * completions messages. Tool results inside a user message are split
 * out into separate `role: "tool"` messages because OpenAI's wire
 * format requires that shape.
 */
function pushTranslatedMessage(out: OpenAIMessage[], msg: Message): void {
  if (msg.role === "system") {
    out.push({ role: "system", content: stringContent(msg.content) });
    return;
  }

  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      out.push({ role: "user", content: msg.content });
      return;
    }
    const textPieces: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        textPieces.push(block.text);
      } else if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.content,
        });
      }
    }
    if (textPieces.length > 0) {
      out.push({ role: "user", content: textPieces.join("\n") });
    }
    return;
  }

  // assistant
  if (typeof msg.content === "string") {
    out.push({ role: "assistant", content: msg.content });
    return;
  }
  const textPieces: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      textPieces.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }
  const assistantMsg: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  } = {
    role: "assistant",
    content: textPieces.length > 0 ? textPieces.join("\n") : null,
  };
  if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
  out.push(assistantMsg);
}

function stringContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const pieces: string[] = [];
  for (const block of content) {
    if (block.type === "text") pieces.push(block.text);
  }
  return pieces.join("\n");
}

function mapOpenAIStopReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return "error";
  }
}

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

function mapErrorToFunClaw(err: unknown, model: string, providerName: string): ProviderError {
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("FC-2")
  ) {
    return err as ProviderError;
  }

  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const ctx = { provider: providerName, model, cause: err };
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
    provider: providerName,
    model,
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}
