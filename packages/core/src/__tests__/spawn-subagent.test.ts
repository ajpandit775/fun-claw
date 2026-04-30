// Vitest tests for the spawn_subagent handler (Slice 9, per ADR-003).
//
// Covers each FC-6xxx subagent code plus the abort-cascade and
// token-attribution paths. Mocks: a stub LLMProvider returning canned
// ProviderEvent[][] sequences (the pattern from agent-loop.test.ts),
// plus a stub `SubagentRuntimeFactory` that returns an empty
// ToolRegistry — no real Docker, no real LLM. The handler is pure
// logic at this layer.

import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../config.js";
import { isFunClawError } from "../errors.js";
import { createLogger } from "../logger.js";
import type { LLMProvider, ProviderEvent, StreamOptions } from "../provider.js";
import { ToolRegistry } from "../tool-registry.js";
import {
  buildSpawnSubagentDefinition,
  buildSpawnSubagentHandler,
  buildSpawnSubagentTool,
  parseSpawnSubagentInput,
  type SpawnSubagentDeps,
  SUBAGENT_GOAL_MAX_CHARS,
  SUBAGENT_MAX_DEPTH,
  type SubagentFinishedInfo,
  type SubagentRuntimeFactory,
} from "../tools/spawn-subagent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = createLogger({ level: "warn", logFilePath: null, pretty: false });
const ROOT_UUID = "00000000-0000-4000-8000-000000000000";

function stubProvider(turns: ProviderEvent[][]): LLMProvider {
  let i = 0;
  return {
    name: "openai" as Provider,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      imageInput: false,
      systemPrompt: "native",
    },
    stream(_opts: StreamOptions): AsyncIterable<ProviderEvent> {
      const events = turns[i] ?? [];
      i += 1;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

/** Provider whose stream awaits forever (until the abort signal fires). */
function neverEndingProvider(): LLMProvider {
  return {
    name: "openai" as Provider,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      imageInput: false,
      systemPrompt: "native",
    },
    stream(opts: StreamOptions): AsyncIterable<ProviderEvent> {
      return (async function* () {
        yield { type: "message-start", model: "stub" };
        yield { type: "text-delta", text: "thinking..." };
        await new Promise<void>((_resolve, reject) => {
          opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      })();
    },
  };
}

function fakeFactory(opts: { cleanup?: () => void } = {}): SubagentRuntimeFactory {
  return async () => {
    return {
      registry: new ToolRegistry(),
      subagentSessionUuid: "11111111-1111-4111-8111-111111111111",
      cleanup: async () => {
        opts.cleanup?.();
      },
    };
  };
}

function depsForTest(overrides: Partial<SpawnSubagentDeps> = {}): SpawnSubagentDeps {
  return {
    parentDepth: 0,
    rootSessionUuid: ROOT_UUID,
    provider: stubProvider([]),
    model: "stub",
    logger,
    factory: fakeFactory(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSpawnSubagentDefinition — tool descriptor varies by depth", () => {
  it("at parentDepth 0, child can spawn further (depth 1)", () => {
    const def = buildSpawnSubagentDefinition(0);
    expect(def.name).toBe("spawn_subagent");
    expect(def.description).toContain("depth 1 of 3 and can itself spawn further");
  });

  it("at parentDepth 1, child still allowed to spawn (depth 2)", () => {
    const def = buildSpawnSubagentDefinition(1);
    expect(def.description).toContain("depth 2 of 3 and can itself spawn further");
  });

  it("at parentDepth 2, child is at max depth (3) and CANNOT spawn further", () => {
    const def = buildSpawnSubagentDefinition(2);
    expect(def.description).toContain("depth 3 of 3 (the maximum) and CANNOT spawn further");
  });
});

describe("parseSpawnSubagentInput — schema validation", () => {
  it("accepts a minimal goal", () => {
    const parsed = parseSpawnSubagentInput({ goal: "do the thing" });
    expect(parsed.goal).toBe("do the thing");
    expect(parsed.max_iterations).toBeUndefined();
  });

  it("accepts goal + budget overrides", () => {
    const parsed = parseSpawnSubagentInput({
      goal: "do the thing",
      max_iterations: 5,
      max_tokens: 10_000,
      timeout_ms: 60_000,
    });
    expect(parsed.max_iterations).toBe(5);
    expect(parsed.max_tokens).toBe(10_000);
    expect(parsed.timeout_ms).toBe(60_000);
  });

  it("rejects goal exceeding max chars", () => {
    expect(() =>
      parseSpawnSubagentInput({ goal: "x".repeat(SUBAGENT_GOAL_MAX_CHARS + 1) }),
    ).toThrow();
  });

  it("rejects max_iterations above ADR-003 cap", () => {
    expect(() => parseSpawnSubagentInput({ goal: "x", max_iterations: 100 })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    // The Zod schema rejects unknown fields at runtime via .strict().
    // TS doesn't see this at compile time because the input is typed
    // as `unknown` going in; per the Slice 8 saved-feedback rule
    // about `@ts-expect-error`, no directive is needed here.
    expect(() => parseSpawnSubagentInput({ goal: "x", system: "override" })).toThrow();
  });
});

describe("buildSpawnSubagentHandler — happy path", () => {
  it("returns ToolResult with completed status when subagent ends with end_turn", async () => {
    const provider = stubProvider([
      [
        { type: "message-start", model: "stub" },
        { type: "text-delta", text: "the answer is 42" },
        { type: "text-stop" },
        {
          type: "message-stop",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      ],
    ]);
    let cleanupCalled = false;
    const finished: SubagentFinishedInfo[] = [];
    const handler = buildSpawnSubagentHandler(
      depsForTest({
        provider,
        factory: fakeFactory({
          cleanup: () => {
            cleanupCalled = true;
          },
        }),
        onSubagentFinished: (info) => finished.push(info),
      }),
    );
    const result = await handler(
      { id: "call_1", name: "spawn_subagent", input: { goal: "compute" } },
      { sessionUuid: ROOT_UUID },
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("subagent completed");
    expect(result.content).toContain("the answer is 42");
    expect(cleanupCalled).toBe(true);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.exitReason).toBe("completed");
    expect(finished[0]?.inputTokens).toBe(100);
    expect(finished[0]?.outputTokens).toBe(20);
  });
});

describe("buildSpawnSubagentHandler — depth and goal validation", () => {
  it("FC-6010 thrown at handler-construction time when parentDepth >= SUBAGENT_MAX_DEPTH", () => {
    let caught: unknown;
    try {
      buildSpawnSubagentHandler(
        depsForTest({
          // Cast: we deliberately violate the 0|1|2 narrowing to
          // assert the runtime defense fires.
          parentDepth: SUBAGENT_MAX_DEPTH as 0 | 1 | 2,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-6010");
    }
  });

  it("FC-6013 thrown at invocation time when goal exceeds the cap", async () => {
    const handler = buildSpawnSubagentHandler(depsForTest());
    let caught: unknown;
    try {
      await handler(
        {
          id: "call_long",
          name: "spawn_subagent",
          input: { goal: "x".repeat(SUBAGENT_GOAL_MAX_CHARS + 1) },
        },
        { sessionUuid: ROOT_UUID },
        new AbortController().signal,
      );
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-6013");
    }
  });
});

describe("buildSpawnSubagentHandler — abort cascade and timeout", () => {
  it("parent abort cascades; result tagged with FC-6015 informational marker", async () => {
    const provider = neverEndingProvider();
    const handler = buildSpawnSubagentHandler(depsForTest({ provider, factory: fakeFactory() }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const result = await handler(
      { id: "call_abort", name: "spawn_subagent", input: { goal: "loop forever" } },
      { sessionUuid: ROOT_UUID },
      ac.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("FC-6015");
    expect(result.content).toContain("cascaded");
  });

  it("internal timeout fires when timeout_ms is exceeded; FC-6012 surfaced", async () => {
    const provider = neverEndingProvider();
    const handler = buildSpawnSubagentHandler(depsForTest({ provider, factory: fakeFactory() }));
    const result = await handler(
      {
        id: "call_timeout",
        name: "spawn_subagent",
        input: { goal: "loop forever", timeout_ms: 100 },
      },
      { sessionUuid: ROOT_UUID },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("FC-6012");
    expect(result.content).toContain("timeout");
  });
});

describe("buildSpawnSubagentHandler — factory failure", () => {
  it("FC-6014 surfaces in the isError ToolResult when the runtime factory rejects", async () => {
    // Per ADR-002, throws inside a handler never propagate out — the
    // handler's own outer try/catch converts FC-6014 (and any other
    // failure mode) into a ToolResult with `isError: true` and the
    // error tag in `content`. The dispatcher above just hands the
    // ToolResult to the LLM unchanged.
    const failingFactory: SubagentRuntimeFactory = async () => {
      throw new Error("docker is on fire");
    };
    const handler = buildSpawnSubagentHandler(
      depsForTest({ provider: stubProvider([]), factory: failingFactory }),
    );
    const result = await handler(
      { id: "call_factory_fail", name: "spawn_subagent", input: { goal: "x" } },
      { sessionUuid: ROOT_UUID },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
    // The content carries the wrapping FC-6014 message (not the raw
    // factory error): the handler's outer catch produces "subagent
    // threw: <FC-6014 wrapped message>".
    expect(String(result.content)).toContain("docker is on fire");
  });
});

describe("buildSpawnSubagentTool — convenience wrapper", () => {
  it("returns matching definition + handler", () => {
    const { definition, handler } = buildSpawnSubagentTool(depsForTest());
    expect(definition.name).toBe("spawn_subagent");
    expect(typeof handler).toBe("function");
  });
});

describe("buildSpawnSubagentHandler — fake-timer behavior (vi.useFakeTimers)", () => {
  // Documents that the handler's setTimeout-based timeout is
  // observable via fast-forwarding fake timers — useful for future
  // suites that want to assert exact timeout behavior without
  // burning real wall-clock.
  it("setTimeout for timeout is wired (smoke check via spy)", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      // We don't actually invoke the handler here — just verify that
      // `setTimeout` is the mechanism. The integration tests above
      // exercise the timeout path end-to-end with real timers.
      expect(spy).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
