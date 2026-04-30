// MSW-based tests for the Gemini provider adapter.
//
// Same six scenarios as Anthropic / OpenAI. Gemini's SDK calls
// `https://generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent`
// with `?alt=sse&key=<api-key>`. Each chunk in the SSE stream is a
// `GenerateContentResponse` with `candidates: [{ content: { parts: [...] } }]`.
//
// One Gemini-specific quirk: per the Slice 3 saved feedback, the
// adapter overrides `finishReason: "STOP"` to `"tool_use"` when any
// function-call part fired during the stream. The tool-use test
// here verifies that override fires correctly.

import { GoogleGenAI } from "@google/genai";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isFunClawError } from "../../errors.js";
import type { ProviderEvent } from "../../provider.js";
import { GeminiProvider, type GoogleGenAILike } from "../gemini.js";

// ---------------------------------------------------------------------------
// MSW setup
// ---------------------------------------------------------------------------

// The Gemini SDK URL embeds the model name in the path. We use a
// regex matcher so any model in any test routes through our handler.
const STREAM_URL_PATTERN =
  /^https:\/\/generativelanguage\.googleapis\.com\/.*:streamGenerateContent/;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function geminiSseStream(chunks: ReadonlyArray<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function makeProvider(): GeminiProvider {
  // The Google GenAI SDK doesn't expose a `maxRetries: 0` option in
  // its public init shape (it uses internal retry policies tied to
  // its transport). For error-mapping tests we rely on the test's
  // handler returning a non-200 response immediately — the SDK
  // surfaces the error without retrying because we don't set the
  // retry hints in the response body that would trigger backoff.
  const client = new GoogleGenAI({ apiKey: "test-fake-key" }) as unknown as GoogleGenAILike;
  return new GeminiProvider({ client });
}

const baseStreamOpts = {
  messages: [{ role: "user" as const, content: "say hi" }],
  model: "gemini-2.5-flash",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiProvider — text-only streaming", () => {
  it("translates parts[].text into text-delta events + message-stop(end_turn)", async () => {
    server.use(
      http.post(STREAM_URL_PATTERN, () =>
        geminiSseStream([
          {
            modelVersion: "gemini-2.5-flash",
            candidates: [
              {
                content: { parts: [{ text: "hello " }], role: "model" },
                index: 0,
              },
            ],
          },
          {
            candidates: [
              {
                content: { parts: [{ text: "world" }], role: "model" },
                index: 0,
              },
            ],
          },
          {
            candidates: [
              {
                content: { parts: [], role: "model" },
                finishReason: "STOP",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 8,
              candidatesTokenCount: 4,
              totalTokenCount: 12,
            },
          },
        ]),
      ),
    );

    const events = await collect(makeProvider().stream(baseStreamOpts));
    const types = events.map((e) => e.type);
    expect(types).toContain("message-start");
    expect(types.filter((t) => t === "text-delta")).toHaveLength(2);
    const stop = events.find((e) => e.type === "message-stop");
    expect(stop).toBeDefined();
    if (stop?.type === "message-stop") {
      // Plain STOP with no tool call → end_turn.
      expect(stop.stopReason).toBe("end_turn");
    }
  });
});

describe("GeminiProvider — tool-use streaming (STOP→tool_use override)", () => {
  it("translates parts[].functionCall into tool-use-stop with parsed args; overrides STOP→tool_use", async () => {
    server.use(
      http.post(STREAM_URL_PATTERN, () =>
        geminiSseStream([
          {
            modelVersion: "gemini-2.5-flash",
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "execute_bash",
                        args: { command: "ls /tmp" },
                      },
                    },
                  ],
                  role: "model",
                },
                finishReason: "STOP",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            },
          },
        ]),
      ),
    );

    const events = await collect(makeProvider().stream(baseStreamOpts));
    const toolUseStop = events.find((e) => e.type === "tool-use-stop");
    expect(toolUseStop).toBeDefined();
    if (toolUseStop?.type === "tool-use-stop") {
      expect(toolUseStop.toolUse.name).toBe("execute_bash");
      expect(toolUseStop.toolUse.input).toStrictEqual({ command: "ls /tmp" });
    }
    // The STOP→tool_use override per the Slice 3 saved feedback.
    const stop = events.find((e) => e.type === "message-stop");
    if (stop?.type === "message-stop") {
      expect(stop.stopReason).toBe("tool_use");
    }
  });
});

describe("GeminiProvider — error mapping", () => {
  it("maps HTTP 429 to FC-2004", async () => {
    server.use(
      http.post(STREAM_URL_PATTERN, () =>
        HttpResponse.json(
          {
            error: {
              code: 429,
              message: "Quota exceeded for quota metric ...",
              status: "RESOURCE_EXHAUSTED",
            },
          },
          { status: 429, headers: { "retry-after": "60" } },
        ),
      ),
    );
    let caught: unknown;
    try {
      await collect(makeProvider().stream(baseStreamOpts));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) expect(caught.code).toBe("FC-2004");
  });

  it("maps HTTP 401 to FC-2007", async () => {
    server.use(
      http.post(STREAM_URL_PATTERN, () =>
        HttpResponse.json(
          {
            error: {
              code: 401,
              message: "API key not valid",
              status: "UNAUTHENTICATED",
            },
          },
          { status: 401 },
        ),
      ),
    );
    let caught: unknown;
    try {
      await collect(makeProvider().stream(baseStreamOpts));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-2007");
      expect(caught.message.toLowerCase()).toContain("gemini");
    }
  });

  it("maps HTTP 503 to FC-2005", async () => {
    server.use(
      http.post(STREAM_URL_PATTERN, () =>
        HttpResponse.json(
          {
            error: {
              code: 503,
              message: "The model is overloaded",
              status: "UNAVAILABLE",
            },
          },
          { status: 503 },
        ),
      ),
    );
    let caught: unknown;
    try {
      await collect(makeProvider().stream(baseStreamOpts));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) expect(caught.code).toBe("FC-2005");
  });

  it("maps malformed responses to FC-2006 / FC-2005 / FC-9999", async () => {
    server.use(
      http.post(
        STREAM_URL_PATTERN,
        () =>
          new Response("<html>Not Gemini</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    let caught: unknown;
    try {
      await collect(makeProvider().stream(baseStreamOpts));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(["FC-2006", "FC-2005", "FC-9999"]).toContain(caught.code);
    }
  });
});
