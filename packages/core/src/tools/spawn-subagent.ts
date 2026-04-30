// Fun Claw — spawn_subagent tool (per ADR-003).
//
// This is the third built-in tool, joining `execute_bash` and
// `write_file`. Where those two live in `@funclaw/docker-runner`
// (because they bind to a SessionHandle), spawn_subagent lives here
// in `@funclaw/core` because:
//   - It dispatches a NEW agent loop, which is core territory.
//   - It needs no Docker dependency at the type level — the runner
//     dependency is injected via a `SubagentRunnerFactory` callback.
//
// Architectural notes:
//
//   - The handler runs the subagent loop SYNCHRONOUSLY from the
//     parent's perspective: it kicks off `runAgentLoop`, iterates the
//     yielded events to capture state, and returns a single
//     ToolResult when the subagent exits. The subagent's events do
//     NOT bubble up to the parent's consumer — they're consumed
//     internally for tally + final-text extraction.
//
//   - Cleanup: the subagent's container is created at the start of
//     the handler and destroyed in a `finally` block, regardless of
//     how the loop exits (normal completion, abort cascade,
//     timeout, error). Per ADR-003: "the container is ephemeral".
//
//   - Abort cascade: the handler builds a child AbortController
//     whose signal aborts when ANY of (parent signal, internal
//     timeout, internal token cap) fires. Per ADR-003, parent abort
//     cascades to subagents but a subagent's internal abort doesn't
//     touch the parent.
//
//   - Token attribution: the handler reports its subagent's usage
//     in the ToolResult content (so the parent sees it) AND invokes
//     the optional `onSubagentFinished` callback so the chat command
//     can aggregate "tokens charge to root" per ADR-003.
//
// Reference docs:
//   - .claude/CLAUDE.md (subagent pre-decisions; FC-6xxx code policy).
//   - docs/adr/ADR-003-subagent-isolation.md (in-process, separate
//     container; depth ≤ 3, ≤ 5 siblings, 50K input tokens, 15
//     iterations, 300s wall clock; tokens charge to root).
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch; the
//     spawn_subagent calls within a turn are subject to both
//     TOOL_CONCURRENCY=10 and SUBAGENT_CONCURRENCY=5 caps).

import { z } from "zod";
import { runAgentLoop } from "../agent-loop.js";
import { funClawError } from "../errors.js";
import type { FunClawLogger } from "../logger.js";
import type { LLMProvider } from "../provider.js";
import { buildSystemPrompt, type SubagentPromptContext } from "../system-prompt.js";
import type { ToolRegistry } from "../tool-registry.js";
import type {
  AgentEvent,
  AgentUsage,
  JSONSchema,
  ToolDefinition,
  ToolHandler,
  ToolResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Constants (ADR-003)
// ---------------------------------------------------------------------------

/** ADR-003: max input tokens per subagent. */
export const SUBAGENT_MAX_TOKENS = 50_000;
/** ADR-003: max agent loop iterations per subagent. */
export const SUBAGENT_MAX_ITERATIONS = 15;
/** ADR-003: wall-clock timeout per subagent, in milliseconds. */
export const SUBAGENT_TIMEOUT_MS = 300_000;
/** Goal length cap (FC-6013). 2000 chars is wide enough for most
 *  subtask descriptions without inviting the parent to dump its
 *  entire context window into a single tool call. */
export const SUBAGENT_GOAL_MAX_CHARS = 2000;
/** ADR-003 absolute depth cap. Parent depth + 1 must be ≤ this. */
export const SUBAGENT_MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

/**
 * Input schema for spawn_subagent. The v1 surface deliberately narrows
 * ADR-003's design (which mentions optional `system` and `tools`
 * overrides) — those LLM-controlled overrides are deferred until a
 * real use case demonstrates need. The v1 surface is goal-only with
 * optional budget overrides clamped to the ADR-003 maxima.
 */
export const SpawnSubagentInputSchema = z
  .object({
    goal: z
      .string()
      .min(1, "goal is required")
      .max(SUBAGENT_GOAL_MAX_CHARS, `goal must be at most ${SUBAGENT_GOAL_MAX_CHARS} characters`)
      .describe(
        "The subtask for the subagent to focus on. The subagent receives this as its system prompt's `## Your goal` section.",
      ),
    max_iterations: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_MAX_ITERATIONS)
      .optional()
      .describe(
        `Optional override for the subagent's agent-loop iteration cap. Default ${SUBAGENT_MAX_ITERATIONS}; the per-ADR-003 maximum is also ${SUBAGENT_MAX_ITERATIONS}.`,
      ),
    max_tokens: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_MAX_TOKENS)
      .optional()
      .describe(
        `Optional override for the subagent's input-token budget. Default ${SUBAGENT_MAX_TOKENS}; the per-ADR-003 maximum is also ${SUBAGENT_MAX_TOKENS}.`,
      ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_TIMEOUT_MS)
      .optional()
      .describe(
        `Optional override for the subagent's wall-clock timeout in milliseconds. Default ${SUBAGENT_TIMEOUT_MS} (300s); the per-ADR-003 maximum is also ${SUBAGENT_TIMEOUT_MS}.`,
      ),
  })
  .strict();

export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInputSchema>;

/**
 * Possible exit reasons for a subagent loop. Surfaced in the
 * ToolResult content so the parent's LLM can decide whether to
 * retry, route around, or summarize.
 */
export type SubagentExitReason =
  | "completed"
  | "max_iterations"
  | "max_tokens"
  | "timeout"
  | "aborted"
  | "error";

/**
 * Per-invocation context the chat command (or another subagent's
 * spawn_subagent handler) builds when constructing a fresh
 * spawn_subagent tool for a registry. Captures the parent's depth +
 * the dependencies the handler needs to run a child loop.
 */
export interface SpawnSubagentDeps {
  /** Recursion depth of the loop registering this tool. The handler
   *  asserts `parentDepth + 1 ≤ SUBAGENT_MAX_DEPTH` (FC-6010 if not
   *  — defense-in-depth; chat.ts SHOULD already not register the
   *  tool at parentDepth = 3). */
  parentDepth: 0 | 1 | 2;
  /** UUID of the root session — used in container labels via the
   *  factory. Constant for the entire chat session, even across
   *  nested subagents. */
  rootSessionUuid: string;
  /** Provider for LLM calls. Same instance the parent uses. */
  provider: LLMProvider;
  /** Model identifier. Same as parent. */
  model: string;
  /** Logger; the handler emits structured info logs for observability
   *  (subagent UUID, depth, exit reason, token usage). */
  logger: FunClawLogger;
  /**
   * Factory that creates a fresh subagent runtime: a tool registry +
   * cleanup callback. Called once per spawn_subagent invocation.
   * Returns:
   *   - `registry` — fresh ToolRegistry the subagent's runAgentLoop
   *     will dispatch through. Per the kickoff: built-ins (fresh
   *     execute_bash + write_file bound to the subagent's
   *     SessionHandle) + inherited skills + inherited MCP tools +
   *     (if depth+1 < 3) a recursive spawn_subagent at depth+1.
   *   - `subagentSessionUuid` — the subagent's session UUID, for
   *     logs and cleanup tracking.
   *   - `cleanup` — async function to destroy the subagent's
   *     container. Always called in a `finally` block.
   */
  factory: SubagentRuntimeFactory;
  /**
   * Optional callback fired when the subagent loop exits with usage
   * statistics. The chat command uses this to aggregate "tokens
   * charge to root" per ADR-003. The handler invokes this callback
   * regardless of exit reason (completed, max_iterations, timeout,
   * etc.) — usage is real even when the subagent ran out of budget.
   */
  onSubagentFinished?: (info: SubagentFinishedInfo) => void;
}

/**
 * Per-spawn factory output. The subagent UUID and cleanup function
 * are returned alongside the registry so the handler can label logs
 * and ensure container teardown.
 */
export interface SubagentRuntimeFactoryResult {
  registry: ToolRegistry;
  subagentSessionUuid: string;
  cleanup: () => Promise<void>;
}

/**
 * Factory function the chat command supplies. Takes the
 * about-to-be-spawned subagent's depth + abort signal and returns a
 * configured runtime. Errors thrown here surface as FC-6014.
 */
export type SubagentRuntimeFactory = (args: {
  childDepth: 1 | 2 | 3;
  abortSignal: AbortSignal;
}) => Promise<SubagentRuntimeFactoryResult>;

/** Diagnostic info passed to `onSubagentFinished`. */
export interface SubagentFinishedInfo {
  subagentSessionUuid: string;
  depth: 1 | 2 | 3;
  exitReason: SubagentExitReason;
  iterationsUsed: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tool definition (advertised to the LLM)
// ---------------------------------------------------------------------------

/**
 * Build the `spawn_subagent` ToolDefinition. The description varies
 * slightly by depth so the LLM at depth N understands its capability
 * relative to the cap at N+1 (e.g., a depth-2 parent sees that its
 * subagents will be at depth 3 and unable to spawn further).
 */
export function buildSpawnSubagentDefinition(parentDepth: 0 | 1 | 2): ToolDefinition {
  const childDepth = (parentDepth + 1) as 1 | 2 | 3;
  const childCanSpawn = childDepth < SUBAGENT_MAX_DEPTH;
  const description =
    "Spawn a subagent to handle a focused subtask in isolation. " +
    "The subagent runs in its own ephemeral Docker container with its own context window, returns its final assistant message as this tool's result, " +
    `and is capped at ${SUBAGENT_MAX_ITERATIONS} loop iterations / ${SUBAGENT_MAX_TOKENS} input tokens / ${Math.round(
      SUBAGENT_TIMEOUT_MS / 1000,
    )}s wall clock. ` +
    `It will inherit your skills and MCP tools but get fresh /workspace and /tmp. ` +
    (childCanSpawn
      ? `The subagent will run at depth ${childDepth} of 3 and can itself spawn further subagents.`
      : `The subagent will run at depth ${childDepth} of 3 (the maximum) and CANNOT spawn further subagents itself — it has to do the work or report what it can.`) +
    " Use this for parallelizable subtasks, focused research, or anything where you want a clean context window. The result you receive is a text summary; ask the subagent to format structured output explicitly if you need JSON.";
  return {
    name: "spawn_subagent",
    description,
    inputSchema: z.toJSONSchema(SpawnSubagentInputSchema) as JSONSchema,
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Construct a `ToolHandler` for spawn_subagent at a given parent
 * depth. Closes over the deps so the handler signature stays the
 * generic `ToolHandler` shape the agent loop's dispatcher expects.
 *
 * Throws FC-6010 immediately if `parentDepth + 1 > SUBAGENT_MAX_DEPTH`
 * — the chat command shouldn't register the tool at parentDepth = 3,
 * but this is defense-in-depth.
 */
export function buildSpawnSubagentHandler(deps: SpawnSubagentDeps): ToolHandler {
  if (deps.parentDepth >= SUBAGENT_MAX_DEPTH) {
    throw funClawError({
      code: "FC-6010",
      message:
        `spawn_subagent cannot be registered at depth ${deps.parentDepth}: subagents are capped at depth ${SUBAGENT_MAX_DEPTH} (per ADR-003). ` +
        "The chat command should not register this tool for depth-3 loops.",
      data: { parentDepth: deps.parentDepth, maxDepth: SUBAGENT_MAX_DEPTH },
    });
  }
  const childDepth = (deps.parentDepth + 1) as 1 | 2 | 3;

  return async (toolCall, _context, parentAbortSignal) => {
    // (FC-6013) Goal length validation before any expensive work.
    // The Zod schema also enforces this; parsing happens here so the
    // dispatcher can convert the throw to an isError tool_result via
    // the standard ADR-002 boundary catch.
    let parsed: SpawnSubagentInput;
    try {
      parsed = SpawnSubagentInputSchema.parse(toolCall.input);
    } catch (err) {
      // ZodError on goal-too-long: surface as FC-6013 specifically.
      if (
        err !== null &&
        typeof err === "object" &&
        "issues" in err &&
        Array.isArray((err as { issues?: unknown }).issues)
      ) {
        const issues = (err as { issues: Array<{ path: ReadonlyArray<string | number> }> }).issues;
        const goalIssue = issues.find((i) => i.path[0] === "goal");
        if (goalIssue !== undefined) {
          throw funClawError({
            code: "FC-6013",
            message: `spawn_subagent goal failed validation (max ${SUBAGENT_GOAL_MAX_CHARS} chars).`,
            cause: err,
            data: { input: toolCall.input },
          });
        }
      }
      throw err; // Other Zod issues — let the dispatcher convert.
    }

    const goal = parsed.goal;
    const maxIterations = parsed.max_iterations ?? SUBAGENT_MAX_ITERATIONS;
    const maxTokens = parsed.max_tokens ?? SUBAGENT_MAX_TOKENS;
    const timeoutMs = parsed.timeout_ms ?? SUBAGENT_TIMEOUT_MS;

    // Build the chained AbortController. Three abort sources:
    //   1. Parent's signal (cascades from chat.ts on Ctrl-C).
    //   2. Per-subagent timeout (FC-6012).
    //   3. Per-subagent token cap (FC-6011, fired from the message-stop
    //      event handler when accumulated input tokens exceed maxTokens).
    // AbortSignal.any was added in Node 20+; Node 22 LTS supports it.
    const localController = new AbortController();
    const chainedSignal = AbortSignal.any([parentAbortSignal, localController.signal]);

    // Timeout enforcement (FC-6012). Cleared in finally.
    let timeoutFired = false;
    const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
      timeoutFired = true;
      localController.abort(new Error("FC-6012 subagent timeout"));
    }, timeoutMs);

    // Build the subagent's runtime (fresh container, fresh registry)
    // and run the loop. All paths converge in the finally for
    // cleanup.
    const startMs = Date.now();
    let factoryResult: SubagentRuntimeFactoryResult | undefined;
    let exitReason: SubagentExitReason = "error";
    let finalText = "";
    let iterationsUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let tokensCapFired = false;

    try {
      // (FC-6014) Container creation failures surface as FC-6014.
      try {
        factoryResult = await deps.factory({
          childDepth,
          abortSignal: chainedSignal,
        });
      } catch (factoryErr) {
        throw funClawError({
          code: "FC-6014",
          message: `spawn_subagent could not create the subagent runtime: ${factoryErr instanceof Error ? factoryErr.message : String(factoryErr)}`,
          cause: factoryErr,
          data: { goal: goal.slice(0, 80) },
        });
      }

      const subagentSystemPrompt = buildSystemPrompt({
        tools: factoryResult.registry.getDefinitions(),
        sessionUuid: factoryResult.subagentSessionUuid,
        mcpServerNames: factoryResult.registry.getMcpServerNames(),
        subagent: { depth: childDepth, goal } satisfies SubagentPromptContext,
      });

      deps.logger.info(
        {
          subagentSessionUuid: factoryResult.subagentSessionUuid,
          rootSessionUuid: deps.rootSessionUuid,
          parentToolUseId: toolCall.id,
          depth: childDepth,
          goalPreview: goal.slice(0, 120),
          maxIterations,
          maxTokens,
          timeoutMs,
        },
        "subagent spawning",
      );

      // Iterate the subagent's events and capture the state we care
      // about. The events are NOT yielded back to the parent — the
      // parent sees only the final ToolResult.
      const events: AsyncIterable<AgentEvent> = runAgentLoop({
        provider: deps.provider,
        registry: factoryResult.registry,
        initialMessages: [{ role: "user", content: goal }],
        systemPrompt: subagentSystemPrompt,
        model: deps.model,
        sessionUuid: factoryResult.subagentSessionUuid,
        maxIterations,
        abortSignal: chainedSignal,
        depth: childDepth,
      });

      let lastTurnText = "";
      let lastUsage: AgentUsage | undefined;
      for await (const event of events) {
        switch (event.type) {
          case "turn-start":
            iterationsUsed = event.iteration;
            break;
          case "text-delta":
            lastTurnText += event.text;
            break;
          case "turn-stop": {
            if (event.usage !== undefined) {
              lastUsage = event.usage;
              inputTokens += event.usage.inputTokens;
              outputTokens += event.usage.outputTokens;
              // (FC-6011) Token cap: between turns, check whether
              // accumulated input tokens have crossed the budget. If
              // so, abort the chained signal so the next turn (if
              // any) sees the abort and bails. We DON'T throw here —
              // the loop's own abort path produces a clean turn-stop.
              if (inputTokens >= maxTokens && !localController.signal.aborted) {
                tokensCapFired = true;
                localController.abort(new Error("FC-6011 subagent token cap"));
              }
            }
            // Per ADR-003 the subagent's "final answer" is its last
            // assistant text. We capture lastTurnText AFTER the
            // terminal turn (when stopReason is end_turn / aborted /
            // max_iterations / error) but reset before tool_use turns
            // so an intermediate text+tool_use turn doesn't pollute
            // the result.
            if (event.stopReason === "tool_use") {
              lastTurnText = "";
            }
            // Map subagent loop's terminal stop reasons to our
            // SubagentExitReason vocabulary. These categories also
            // pick up budget-cap aborts via the chained signal:
            // tokensCapFired and timeoutFired flags discriminate.
            if (event.stopReason === "end_turn") exitReason = "completed";
            else if (event.stopReason === "max_iterations") exitReason = "max_iterations";
            else if (event.stopReason === "aborted") {
              if (timeoutFired) exitReason = "timeout";
              else if (tokensCapFired) exitReason = "max_tokens";
              else exitReason = "aborted";
            } else if (event.stopReason === "error") exitReason = "error";
            break;
          }
          case "iteration-cap-hit":
            exitReason = "max_iterations";
            break;
          case "error":
            exitReason = "error";
            break;
          // tool-call-start, tool-call-result are observed but not
          // surfaced — they're internal to the subagent.
          default:
            break;
        }
      }
      finalText = lastTurnText.trim();
      // Defensive: if we never saw usage from any turn, leave the
      // counters at 0. lastUsage is unused beyond this fallback log.
      if (lastUsage === undefined) {
        deps.logger.debug(
          { subagentSessionUuid: factoryResult.subagentSessionUuid },
          "subagent finished without provider-reported usage; counters at 0",
        );
      }
    } catch (err) {
      // Catch-all: anything that bubbled past the subagent loop's
      // own boundary (e.g., FC-6014 from the factory, an unexpected
      // throw from runAgentLoop). Convert to ToolResult with isError;
      // ADR-002 says throws never propagate up to the parent loop.
      exitReason = "error";
      finalText = `subagent threw: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timeoutHandle);
      if (factoryResult !== undefined) {
        try {
          await factoryResult.cleanup();
        } catch (cleanupErr) {
          deps.logger.warn(
            { subagentSessionUuid: factoryResult.subagentSessionUuid, err: cleanupErr },
            "subagent cleanup threw; continuing teardown",
          );
        }
      }
    }

    // FC-6015 isn't an error — it's an informational tag we attach
    // when the parent abort cascaded. The kickoff Seventh defines
    // it as "informational, not an error." We surface it in the
    // ToolResult content so the parent LLM can distinguish "user
    // hit Ctrl-C" from "subagent's own timeout fired."
    const cascadedFromParent =
      parentAbortSignal.aborted && !timeoutFired && !tokensCapFired && exitReason === "aborted";
    if (cascadedFromParent) {
      // exitReason stays "aborted"; the FC-6015 tag is appended to
      // the result content for diagnostic visibility.
    }

    const durationMs = Date.now() - startMs;
    const subagentSessionUuid = factoryResult?.subagentSessionUuid ?? "(no-session)";
    deps.logger.info(
      {
        subagentSessionUuid,
        depth: childDepth,
        exitReason,
        iterationsUsed,
        inputTokens,
        outputTokens,
        durationMs,
        cascadedFromParent,
      },
      `subagent finished (${exitReason})`,
    );

    deps.onSubagentFinished?.({
      subagentSessionUuid,
      depth: childDepth,
      exitReason,
      iterationsUsed,
      inputTokens,
      outputTokens,
      durationMs,
    });

    // Build the structured ToolResult content. Format: a leading
    // status line the LLM can quickly classify, then the subagent's
    // final text (or an error explanation), then a usage summary.
    const isError = exitReason !== "completed";
    const statusLine = (() => {
      switch (exitReason) {
        case "completed":
          return `subagent completed (depth ${childDepth}, ${iterationsUsed} iter, ${inputTokens} in / ${outputTokens} out tokens, ${durationMs}ms)`;
        case "max_iterations":
          return `[FC-6001] subagent hit iteration cap (${iterationsUsed} iterations) before completing the goal`;
        case "max_tokens":
          return `[FC-6011] subagent hit input-token cap (${inputTokens}/${maxTokens} tokens) before completing the goal`;
        case "timeout":
          return `[FC-6012] subagent hit ${timeoutMs}ms wall-clock timeout before completing the goal`;
        case "aborted":
          return cascadedFromParent
            ? "[FC-6015] subagent aborted: parent agent's abort cascaded (user interrupted, or higher-level cap fired)"
            : "subagent aborted before completing the goal";
        case "error":
          return "subagent ended with an error";
      }
    })();
    const body =
      finalText.length > 0
        ? finalText
        : "(subagent produced no final text — see status line for cause)";
    const content = `${statusLine}\n\n${body}`;
    const result: ToolResult = { toolUseId: toolCall.id, content };
    if (isError) result.isError = true;
    return result;
  };
}

// ---------------------------------------------------------------------------
// Convenience: build the ToolDefinition + handler together
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that returns both the `ToolDefinition` and the
 * `ToolHandler` for spawn_subagent at the given parent depth. Most
 * callers (chat.ts and the recursive subagent factory) want both.
 */
export function buildSpawnSubagentTool(deps: SpawnSubagentDeps): {
  definition: ToolDefinition;
  handler: ToolHandler;
} {
  return {
    definition: buildSpawnSubagentDefinition(deps.parentDepth),
    handler: buildSpawnSubagentHandler(deps),
  };
}

/**
 * Validate input directly (without invoking a handler). Useful for
 * tests or for the chat command's pre-flight checks. Throws the same
 * Zod-flavored error that the handler converts to FC-6013.
 */
export function parseSpawnSubagentInput(raw: unknown): SpawnSubagentInput {
  return SpawnSubagentInputSchema.parse(raw);
}
