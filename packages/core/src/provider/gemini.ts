// Fun Claw — Google Gemini provider adapter.
//
// Wraps `@google/genai`'s `models.generateContentStream()`. Gemini's API
// is more divergent than Anthropic / OpenAI:
//
//   - Content is parts-based: each Content has `parts: Part[]` where a
//     Part is exactly one of `{ text }` / `{ functionCall }` /
//     `{ functionResponse }`.
//   - System prompts go in `config.systemInstruction` at the top level,
//     not in the contents array.
//   - Tool definitions are declared once on `config.tools`, not attached
//     to messages.
//   - Function calls arrive **complete in a single Part** — Gemini does
//     not stream tool input as fragments. The adapter therefore emits
//     `tool-use-start` and `tool-use-stop` back-to-back from the same
//     Part, with no accumulation.
//   - Tool IDs: Gemini's `functionCall.id` is optional. When absent (the
//     common case in v1.x), the adapter synthesizes one so IDs still
//     round-trip end-to-end per ADR-002.
//
// Reference docs:
//   - .claude/CLAUDE.md (FC-2xxx scoping rule, 2026-04-28)
//   - STACK.md "LLM providers" (@google/genai ^1.48 — the new unified
//     SDK; @google/generative-ai is forbidden)
//   - docs/adr/ADR-002-tool-dispatch.md

import { GoogleGenAI } from "@google/genai";
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
import type { ContentBlock, StopReason, ToolUseBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const GEMINI_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  imageInput: true,
  systemPrompt: "native",
});

// ---------------------------------------------------------------------------
// Minimal SDK shape we depend on
// ---------------------------------------------------------------------------

export interface GoogleGenAILike {
  models: {
    generateContentStream(request: GeminiRequest): Promise<AsyncIterable<GeminiChunk>>;
  };
}

interface GeminiRequest {
  model: string;
  contents: GeminiContent[];
  config?: {
    systemInstruction?: string;
    maxOutputTokens?: number;
    abortSignal?: AbortSignal;
    tools?: Array<{ functionDeclarations: GeminiFunctionDecl[] }>;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | {
      functionCall: {
        id?: string;
        name: string;
        args: Record<string, unknown>;
      };
    }
  | {
      functionResponse: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
      };
    };

interface GeminiFunctionDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiChunk {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GeminiProviderOptions {
  apiKey?: string;
  client?: GoogleGenAILike;
}

export class GeminiProvider implements LLMProvider {
  readonly name: Provider = "gemini";
  readonly capabilities: ProviderCapabilities = GEMINI_CAPABILITIES;
  private readonly client: GoogleGenAILike;

  constructor(opts: GeminiProviderOptions = {}) {
    if (opts.client !== undefined) {
      this.client = opts.client;
    } else if (opts.apiKey !== undefined && opts.apiKey !== "") {
      this.client = new GoogleGenAI({
        apiKey: opts.apiKey,
      }) as unknown as GoogleGenAILike;
    } else {
      throw funClawError({
        code: "FC-2001",
        message:
          "GeminiProvider requires either `apiKey` or `client`. " +
          "Set GOOGLE_API_KEY in your environment, or supply a client for testing.",
        data: { provider: "gemini" },
      });
    }
  }

  async *stream(opts: StreamOptions): AsyncIterable<ProviderEvent> {
    const request = translateRequest(opts);

    let stream: AsyncIterable<GeminiChunk>;
    try {
      stream = await this.client.models.generateContentStream(request);
    } catch (err) {
      throw mapErrorToFunClaw(err, opts.model);
    }

    let textOpen = false;
    let modelEmitted = false;
    let capturedStopReason: StopReason = "end_turn";
    let capturedUsage: UsageTokens | undefined;
    let synthIdCounter = 0;
    // Gemini reports finishReason: "STOP" even when the turn ends with a
    // function call (the tool call IS the model's complete output). The
    // agent loop checks `stopReason === "tool_use"` to decide whether to
    // dispatch tools and loop, so we override "end_turn" to "tool_use"
    // when any tool-use-stop has fired in this stream. See CLAUDE.md
    // saved feedback for the rationale.
    let toolUseEmittedThisStream = false;

    try {
      for await (const chunk of stream) {
        const baseRaw = opts._raw === true ? { _raw: chunk } : {};

        if (!modelEmitted) {
          yield {
            type: "message-start",
            ...(chunk.modelVersion !== undefined
              ? { model: chunk.modelVersion }
              : { model: opts.model }),
            ...baseRaw,
          };
          modelEmitted = true;
        }

        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if ("text" in part && typeof part.text === "string") {
            if (part.text.length > 0) {
              if (!textOpen) textOpen = true;
              yield { type: "text-delta", text: part.text, ...baseRaw };
            }
          } else if ("functionCall" in part) {
            if (textOpen) {
              yield { type: "text-stop", ...baseRaw };
              textOpen = false;
            }
            const call = part.functionCall;
            const id =
              call.id !== undefined && call.id !== ""
                ? call.id
                : `gemini_${call.name}_${synthIdCounter++}`;
            // Gemini delivers function calls complete; emit start then
            // stop back-to-back from the same Part.
            yield {
              type: "tool-use-start",
              id,
              name: call.name,
              ...baseRaw,
            };
            const toolUse: ToolUseBlock = {
              type: "tool_use",
              id,
              name: call.name,
              input: call.args ?? {},
            };
            yield { type: "tool-use-stop", toolUse, ...baseRaw };
            toolUseEmittedThisStream = true;
          }
          // functionResponse parts are user-side; we don't see them on a
          // streaming model response.
        }

        if (candidate?.finishReason !== undefined && candidate.finishReason !== "") {
          capturedStopReason = mapGeminiStopReason(candidate.finishReason);
        }

        if (chunk.usageMetadata !== undefined) {
          capturedUsage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }

      if (textOpen) {
        yield { type: "text-stop" };
        textOpen = false;
      }

      // Override "end_turn" → "tool_use" when this stream produced any
      // tool calls (Gemini reports STOP for both cases).
      if (toolUseEmittedThisStream && capturedStopReason === "end_turn") {
        capturedStopReason = "tool_use";
      }

      yield {
        type: "message-stop",
        stopReason: capturedStopReason,
        ...(capturedUsage !== undefined ? { usage: capturedUsage } : {}),
      };
    } catch (err) {
      const fcErr = mapErrorToFunClaw(err, opts.model);
      yield { type: "error", error: fcErr };
      yield { type: "message-stop", stopReason: "error" };
      throw fcErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function translateRequest(opts: StreamOptions): GeminiRequest {
  const systemPieces: string[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of opts.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemPieces.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") systemPieces.push(block.text);
        }
      }
      continue;
    }

    const parts = translateContentToParts(msg.content);
    if (parts.length === 0) continue;
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  const config: NonNullable<GeminiRequest["config"]> = {};
  if (systemPieces.length > 0) {
    config.systemInstruction = systemPieces.join("\n\n");
  }
  if (opts.maxTokens !== undefined) config.maxOutputTokens = opts.maxTokens;
  if (opts.abortSignal !== undefined) config.abortSignal = opts.abortSignal;
  if (opts.tools !== undefined && opts.tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ];
  }

  const request: GeminiRequest = {
    model: opts.model,
    contents,
  };
  if (Object.keys(config).length > 0) request.config = config;
  return request;
}

function translateContentToParts(content: string | ContentBlock[]): GeminiPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }
  const parts: GeminiPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ text: block.text });
    } else if (block.type === "tool_use") {
      const fc: { id?: string; name: string; args: Record<string, unknown> } = {
        name: block.name,
        args: block.input,
      };
      if (block.id !== "") fc.id = block.id;
      parts.push({ functionCall: fc });
    } else if (block.type === "tool_result") {
      // Gemini correlates by name (and id when present). Wrap the result
      // string into a `{ output: ... }` object since Gemini expects an
      // object response payload.
      const fr: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
      } = {
        // Gemini doesn't track our toolUseId-to-name mapping; the agent
        // loop preserves order so positional alignment + id round-trip
        // covers the common case. Use a neutral placeholder name when
        // we don't know it; a future refactor could carry the function
        // name on ToolResultBlock to avoid this.
        name: "tool_result",
        response: { output: block.content, isError: block.isError === true },
      };
      if (block.toolUseId !== "") fr.id = block.toolUseId;
      parts.push({ functionResponse: fr });
    }
  }
  return parts;
}

function mapGeminiStopReason(reason: string): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "error";
  }
}

/**
 * Gemini SDK errors are heterogeneous: some carry `.status` (numeric
 * HTTP), some carry `.code`, some only have a message containing the
 * status. Per the kickoff, we map by status when available and default
 * to FC-2006 (malformed response) for anything we can't classify.
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

  const status = extractStatus(err);
  const ctx = { provider: "gemini", model, cause: err };

  if (status === 401 || status === 403) {
    return providerAuthError(ctx);
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(extractHeaders(err));
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

  return providerMalformedResponseError({
    provider: "gemini",
    model,
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

function extractStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

function extractHeaders(err: unknown): unknown {
  if (err === null || typeof err !== "object") return undefined;
  return (err as { headers?: unknown }).headers;
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
