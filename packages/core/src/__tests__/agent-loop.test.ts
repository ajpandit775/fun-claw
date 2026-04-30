// Vitest tests for `runAgentLoop`.
//
// Three behaviors are exercised: the iteration cap (FC-6001), abort
// handling (caller's AbortSignal stops the loop cleanly), and parallel
// tool dispatch (multiple tool_use blocks in a single turn dispatch
// concurrently and arrive in `tool-call-result` events).
//
// Per the Slice 8 kickoff: "Mock providers via simple object literals
// returning canned ProviderEvents." That's what the helpers below do
// — no MSW, no SDK touch, just hardcoded async generators that yield
// the events we're testing against.

import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import type { Provider } from "../config.js";
import type { LLMProvider, ProviderEvent, StreamOptions } from "../provider.js";
import { ToolRegistry } from "../tool-registry.js";
import type { AgentEvent, ToolDefinition, ToolHandler } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers — minimal mock provider
// ---------------------------------------------------------------------------

/**
 * Build a stub LLMProvider that yields a fixed sequence of
 * ProviderEvents on each `stream()` call. The `turns` array is
 * indexed by call number — the first call gets `turns[0]`, the
 * second `turns[1]`, etc. Useful for testing the loop iteration
 * count and stop conditions.
 */
function stubProvider(turns: ProviderEvent[][]): LLMProvider {
  let callIndex = 0;
  const provider: LLMProvider = {
    name: "anthropic" as Provider,
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      imageInput: false,
      systemPrompt: "native",
    },
    stream(_opts: StreamOptions): AsyncIterable<ProviderEvent> {
      const events = turns[callIndex] ?? [];
      callIndex += 1;
      return (async function* () {
        for (const e of events) {
          yield e;
        }
      })();
    },
  };
  return provider;
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} mock`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const SESSION_UUID = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgentLoop — terminal turns", () => {
  it("yields turn-start, text-delta(s), turn-stop with end_turn for a text-only response", async () => {
    const provider = stubProvider([
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "hello " },
        { type: "text-delta", text: "world" },
        { type: "text-stop" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const registry = new ToolRegistry();

    const events = await collect(
      runAgentLoop({
        provider,
        registry,
        initialMessages: [{ role: "user", content: "say hi" }],
        systemPrompt: "test system",
        model: "test",
        sessionUuid: SESSION_UUID,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("turn-start");
    expect(types.filter((t) => t === "text-delta")).toHaveLength(2);
    const stopEvent = events.find((e) => e.type === "turn-stop");
    expect(stopEvent).toBeDefined();
    if (stopEvent !== undefined && stopEvent.type === "turn-stop") {
      expect(stopEvent.stopReason).toBe("end_turn");
    }
  });
});

describe("runAgentLoop — tool dispatch", () => {
  it("dispatches a single tool call, feeds the result back, then ends on the second turn", async () => {
    const provider = stubProvider([
      // Turn 1: model emits a tool_use, stops with tool_use.
      // Spec-compliant adapters (per ADR-002) only emit tool-use-stop
      // with the assembled block; we mirror that contract here.
      [
        { type: "message-start", model: "test" },
        {
          type: "tool-use-stop",
          toolUse: { type: "tool_use", id: "call_1", name: "echo", input: { msg: "hi" } },
        },
        { type: "message-stop", stopReason: "tool_use" },
      ],
      // Turn 2: model receives the result, emits text, ends.
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "got it" },
        { type: "text-stop" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);

    const registry = new ToolRegistry();
    const echo: ToolHandler = async (toolCall) => ({
      toolUseId: toolCall.id,
      content: `echo: ${(toolCall.input as { msg?: string }).msg ?? ""}`,
    });
    registry.register(tool("echo"), echo);

    const events = await collect(
      runAgentLoop({
        provider,
        registry,
        initialMessages: [{ role: "user", content: "say hi" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
      }),
    );

    const startEvts = events.filter((e) => e.type === "tool-call-start");
    const resultEvts = events.filter((e) => e.type === "tool-call-result");
    expect(startEvts).toHaveLength(1);
    expect(resultEvts).toHaveLength(1);
    if (resultEvts[0]?.type === "tool-call-result") {
      expect(resultEvts[0].result.content).toContain("echo: hi");
    }

    // Two turn-start events → two iterations.
    const turnStarts = events.filter((e) => e.type === "turn-start");
    expect(turnStarts).toHaveLength(2);

    // Final stop is end_turn.
    const stops = events.filter((e) => e.type === "turn-stop");
    const finalStop = stops[stops.length - 1];
    if (finalStop?.type === "turn-stop") {
      expect(finalStop.stopReason).toBe("end_turn");
    }
  });

  it("dispatches multiple tool calls in parallel and surfaces results in order", async () => {
    const provider = stubProvider([
      // Turn 1: two tool calls.
      [
        { type: "message-start", model: "test" },
        {
          type: "tool-use-stop",
          toolUse: { type: "tool_use", id: "c1", name: "slow", input: {} },
        },
        {
          type: "tool-use-stop",
          toolUse: { type: "tool_use", id: "c2", name: "fast", input: {} },
        },
        { type: "message-stop", stopReason: "tool_use" },
      ],
      // Turn 2: model receives results, ends.
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "done" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);

    const registry = new ToolRegistry();
    let slowResolvedAfter = false;
    registry.register(tool("slow"), async (toolCall) => {
      // Resolve after a longer delay to verify parallelism.
      await new Promise((r) => setTimeout(r, 50));
      slowResolvedAfter = true;
      return { toolUseId: toolCall.id, content: "slow done" };
    });
    registry.register(tool("fast"), async (toolCall) => {
      // Fast resolves immediately (next microtask).
      await Promise.resolve();
      // If the loop dispatched serially, slow would already be done by
      // now (false → true here means serial). Parallel dispatch keeps
      // this false at the moment fast settles.
      expect(slowResolvedAfter).toBe(false);
      return { toolUseId: toolCall.id, content: "fast done" };
    });

    const events = await collect(
      runAgentLoop({
        provider,
        registry,
        initialMessages: [{ role: "user", content: "go" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
      }),
    );

    // Per ADR-002 the result events arrive in the same order as the
    // tool_use blocks, even though dispatch is parallel.
    const resultEvts = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool-call-result" }> => e.type === "tool-call-result",
    );
    expect(resultEvts.map((e) => e.call.id)).toStrictEqual(["c1", "c2"]);
    expect(resultEvts[0]?.result.content).toBe("slow done");
    expect(resultEvts[1]?.result.content).toBe("fast done");
  });
});

describe("runAgentLoop — iteration cap and abort", () => {
  it("yields iteration-cap-hit + turn-stop(max_iterations) when maxIterations is reached", async () => {
    // Provider always emits tool_use, never end_turn. Loop should hit
    // the cap.
    const everyTurnIsToolUse = (): ProviderEvent[] => [
      { type: "message-start", model: "test" },
      {
        type: "tool-use-stop",
        toolUse: { type: "tool_use", id: "loop", name: "noop", input: {} },
      },
      { type: "message-stop", stopReason: "tool_use" },
    ];
    const turns: ProviderEvent[][] = Array.from({ length: 10 }, everyTurnIsToolUse);
    const provider = stubProvider(turns);

    const registry = new ToolRegistry();
    registry.register(tool("noop"), async (tc) => ({
      toolUseId: tc.id,
      content: "ok",
    }));

    const events = await collect(
      runAgentLoop({
        provider,
        registry,
        initialMessages: [{ role: "user", content: "spin" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
        maxIterations: 3,
      }),
    );

    const cap = events.find((e) => e.type === "iteration-cap-hit");
    expect(cap).toBeDefined();
    if (cap?.type === "iteration-cap-hit") {
      expect(cap.iterationsSeen).toBe(3);
      expect(cap.error.code).toBe("FC-6001");
    }
    // The terminal stop reason is `max_iterations`.
    const stops = events.filter((e) => e.type === "turn-stop");
    const lastStop = stops[stops.length - 1];
    if (lastStop?.type === "turn-stop") {
      expect(lastStop.stopReason).toBe("max_iterations");
    }
  });

  it("respects an abort signal that fires before the loop starts", async () => {
    const provider = stubProvider([
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "should not appear" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const registry = new ToolRegistry();

    const ac = new AbortController();
    ac.abort();

    const events = await collect(
      runAgentLoop({
        provider,
        registry,
        initialMessages: [{ role: "user", content: "go" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
        abortSignal: ac.signal,
      }),
    );

    // The pre-abort check at the top of the while-loop fires before
    // any turn-start event; the only emission is `turn-stop:aborted`.
    const stops = events.filter((e) => e.type === "turn-stop");
    expect(stops).toHaveLength(1);
    if (stops[0]?.type === "turn-stop") {
      expect(stops[0].stopReason).toBe("aborted");
    }
    // No text deltas should have leaked through.
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
  });

  it("stream-throw-during-abort is classified as `aborted`, not `error` (Slice 9 fix)", async () => {
    // Provider whose stream THROWS when its abortSignal fires —
    // mimicking a real fetch propagating AbortError. Pre-Slice 9, the
    // agent loop's catch block wrapped this as FC-9999 error;
    // post-fix, the catch checks abortSignal.aborted and yields a
    // clean `turn-stop: aborted` instead.
    const throwingOnAbort: LLMProvider = {
      name: "anthropic" as Provider,
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        imageInput: false,
        systemPrompt: "native",
      },
      stream(opts) {
        return (async function* () {
          yield { type: "message-start", model: "test" } as ProviderEvent;
          await new Promise<void>((_resolve, reject) => {
            opts.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("abort propagated as throw")),
              { once: true },
            );
          });
        })();
      },
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const events = await collect(
      runAgentLoop({
        provider: throwingOnAbort,
        registry: new ToolRegistry(),
        initialMessages: [{ role: "user", content: "hang" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
        abortSignal: ac.signal,
      }),
    );
    const stops = events.filter((e) => e.type === "turn-stop");
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
    expect(stops).toHaveLength(1);
    if (stops[0]?.type === "turn-stop") {
      expect(stops[0].stopReason).toBe("aborted");
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 9: depth parameter and re-entrancy
// ---------------------------------------------------------------------------

describe("runAgentLoop — depth parameter (Slice 9)", () => {
  it("accepts a depth parameter and runs to completion", async () => {
    const provider = stubProvider([
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "subagent reply" },
        { type: "text-stop" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgentLoop({
        provider,
        registry: new ToolRegistry(),
        initialMessages: [{ role: "user", content: "subtask" }],
        systemPrompt: "test (depth 1)",
        model: "test",
        sessionUuid: SESSION_UUID,
        depth: 1,
      }),
    );
    const stops = events.filter((e) => e.type === "turn-stop");
    expect(stops).toHaveLength(1);
    if (stops[0]?.type === "turn-stop") {
      expect(stops[0].stopReason).toBe("end_turn");
    }
  });

  it("default depth is 0 (root) when omitted", async () => {
    // The depth field is purely informational at the loop layer —
    // there's no observable side-effect at depth 0 vs depth 1 inside
    // runAgentLoop itself (that's the spawn_subagent handler's job).
    // This test just confirms the option doesn't blow up when
    // omitted, exercising the same code path Slice 6 uses.
    const provider = stubProvider([
      [
        { type: "message-start", model: "test" },
        { type: "text-delta", text: "ok" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgentLoop({
        provider,
        registry: new ToolRegistry(),
        initialMessages: [{ role: "user", content: "go" }],
        systemPrompt: "test",
        model: "test",
        sessionUuid: SESSION_UUID,
      }),
    );
    expect(events.filter((e) => e.type === "turn-stop")).toHaveLength(1);
  });
});

describe("runAgentLoop — re-entrancy (concurrent invocations)", () => {
  it("two concurrent loops with separate providers don't collide on shared state", async () => {
    // The loop is supposed to be re-entrant: no module-level mutable
    // state, every per-invocation variable is function-scoped. Run
    // two loops in parallel with different providers and verify
    // each captures its own provider's events without cross-talk.
    const providerA = stubProvider([
      [
        { type: "message-start", model: "A" },
        { type: "text-delta", text: "from A" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const providerB = stubProvider([
      [
        { type: "message-start", model: "B" },
        { type: "text-delta", text: "from B" },
        { type: "message-stop", stopReason: "end_turn" },
      ],
    ]);
    const [eventsA, eventsB] = await Promise.all([
      collect(
        runAgentLoop({
          provider: providerA,
          registry: new ToolRegistry(),
          initialMessages: [{ role: "user", content: "A go" }],
          systemPrompt: "A system",
          model: "A",
          sessionUuid: "A-uuid",
        }),
      ),
      collect(
        runAgentLoop({
          provider: providerB,
          registry: new ToolRegistry(),
          initialMessages: [{ role: "user", content: "B go" }],
          systemPrompt: "B system",
          model: "B",
          sessionUuid: "B-uuid",
        }),
      ),
    ]);
    // Each loop captured its own provider's text — no cross-talk.
    const aText = eventsA
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    const bText = eventsB
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(aText).toBe("from A");
    expect(bText).toBe("from B");
  });

  it("nested loop (parent + subagent simulated via inline runAgentLoop) keeps state isolated", async () => {
    // Stand-in for the spawn_subagent dispatch pattern: a tool
    // handler in the parent's registry kicks off a SECOND
    // runAgentLoop invocation inline, captures its events, and
    // returns a string. The parent's loop should observe only its
    // own events — the nested loop's events stay inside the
    // handler.
    const subagentEvents = [
      { type: "message-start", model: "sub" },
      { type: "text-delta", text: "subagent done" },
      { type: "message-stop", stopReason: "end_turn" },
    ] as const satisfies readonly ProviderEvent[];
    const parentEvents = [
      { type: "message-start", model: "parent" },
      {
        type: "tool-use-stop",
        toolUse: { type: "tool_use", id: "spawn1", name: "fake_spawn", input: {} },
      },
      { type: "message-stop", stopReason: "tool_use" },
    ] as const satisfies readonly ProviderEvent[];
    const followUp = [
      { type: "message-start", model: "parent" },
      { type: "text-delta", text: "parent done" },
      { type: "message-stop", stopReason: "end_turn" },
    ] as const satisfies readonly ProviderEvent[];

    let subagentEventCount = 0;
    const subagentProvider = stubProvider([[...subagentEvents]]);
    const parentProvider = stubProvider([[...parentEvents], [...followUp]]);

    const handler: ToolHandler = async (toolCall) => {
      // Inline subagent loop. Counts events to verify isolation.
      for await (const _ev of runAgentLoop({
        provider: subagentProvider,
        registry: new ToolRegistry(),
        initialMessages: [{ role: "user", content: "go" }],
        systemPrompt: "sub system",
        model: "sub",
        sessionUuid: "sub-uuid",
        depth: 1,
      })) {
        subagentEventCount += 1;
      }
      return { toolUseId: toolCall.id, content: "subagent finished" };
    };

    const parentRegistry = new ToolRegistry();
    parentRegistry.register(tool("fake_spawn"), handler);

    const parentEventsCollected = await collect(
      runAgentLoop({
        provider: parentProvider,
        registry: parentRegistry,
        initialMessages: [{ role: "user", content: "spawn one" }],
        systemPrompt: "parent system",
        model: "parent",
        sessionUuid: "parent-uuid",
      }),
    );

    // Subagent fired its events.
    expect(subagentEventCount).toBeGreaterThan(0);
    // Parent observed its own tool dispatch, not the subagent's.
    const parentResults = parentEventsCollected.filter((e) => e.type === "tool-call-result");
    expect(parentResults).toHaveLength(1);
    if (parentResults[0]?.type === "tool-call-result") {
      expect(parentResults[0].result.content).toBe("subagent finished");
    }
    // Parent text-deltas: only its own ("parent done"), not the
    // subagent's ("subagent done").
    const parentTexts = parentEventsCollected
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text);
    expect(parentTexts).toContain("parent done");
    expect(parentTexts).not.toContain("subagent done");
  });
});
