// `funclaw chat` — interactive agent loop + ink TUI.
//
// This file (CJS) registers the commander subcommand and wires up the
// runtime dependencies. The actual TUI rendering lives in
// `packages/cli/src/chat-runtime.tsx` (ESM, separate tsup entry) — we
// dynamic-import it at action time because ink 5.x is ESM-only with
// top-level await and cannot be `require()`d from CJS. See the Slice 6
// Task 2 saved-feedback entry in CLAUDE.md for the architectural why.
//
// Wiring order:
//   1. loadConfig() — resolve provider + model + workingDir + endpoint
//      + mcp.
//   2. createProvider() — calls getSecret() internally; bails with
//      FC-2001 / FC-2002 / FC-2007 on key problems.
//   3. discoverSkills() (Slice 8): walk the three sources
//      (bundled / user / project) and resolve the per-session skill
//      set. Per-skill parse failures are logged warnings (FC-4xxx)
//      and skipped; they do not abort the chat session.
//   4. DockerRunner.ensureImage() — pulls the runtime sandbox image if
//      not cached. FC-1001 if Docker is unreachable; FC-1022 if pull
//      fails.
//   5. MCP startup (Slice 7): for each enabled `[mcp.<name>]` server,
//      spawn via McpClient.connect, register its tools in the
//      registry. Per-server failures are logged warnings (FC-3xxx);
//      they do not abort the chat session.
//   6. DockerRunner.createSession() — labels container with the chat
//      session UUID for Slice 10 doctor cleanup; runs the one-time
//      uid-10001 setup; mounts each discovered skill at
//      `/skills/<name>` read-only (Slice 8).
//   7. ToolRegistry already has MCP tools from step 5; register
//      `execute_bash`, `write_file`, and one `skill__<name>` tool per
//      discovered skill against the live session handle.
//   8. buildSystemPrompt() — embeds the ADR-001 boundary marker
//      contract; includes the MCP-trust paragraph when MCP servers
//      contributed tools, and the skills-available section when
//      skills loaded.
//   9. Dynamic import of chat-runtime.mjs → startChatTui().
//   10. On exit (clean, Ctrl-C, or error): disconnect every active
//       McpClient, then destroySession.

import { randomUUID } from "node:crypto";
import {
  buildSpawnSubagentTool,
  buildSystemPrompt,
  createProvider,
  type FunClawLogger,
  funClawError,
  isFunClawError,
  type LLMProvider,
  loadConfig,
  type McpRegistrationEntry,
  type McpServerConfig,
  type Provider,
  SUBAGENT_MAX_DEPTH,
  type SubagentFinishedInfo,
  type SubagentRuntimeFactory,
  type SubagentRuntimeFactoryResult,
  type ToolDefinition,
  type ToolHandler,
  ToolRegistry,
  type UserConfig,
} from "@funclaw/core";
import {
  DockerRunner,
  executeBashTool,
  parseExecuteBashInput,
  parseWriteFileInput,
  runExecuteBashSync,
  runWriteFile,
  type SessionHandle,
  type SkillMount,
  writeFileTool,
} from "@funclaw/docker-runner";
import {
  buildPrefixedToolName,
  formatMcpCallToolResult,
  McpClient,
  mcpToolUnavailableError,
} from "@funclaw/mcp-client";
import { type DiscoveredSkill, discoverSkills } from "@funclaw/skills";
import type { Command } from "commander";

/**
 * Per-provider fallback model when `config.defaultModel` is unset.
 * Mirrors the init wizard's `DEFAULT_MODEL_BY_PROVIDER` so existing
 * users without a `defaultModel` field still get a sensible model.
 * `openai-compatible` has no useful default (the user's endpoint
 * dictates the model namespace) — empty string triggers FC-6005.
 */
const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<Provider, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
  "openai-compatible": "",
};

/**
 * Default sandbox image when `config.runtimeImage` is unset. Points
 * at the published runtime image whose Dockerfile lives at
 * `packages/runtime-image/`. Released alongside the matching CLI
 * version — bump in lockstep when issuing a new release.
 */
const DEFAULT_RUNTIME_IMAGE = "ghcr.io/ajpandit775/fun-claw-runtime:0.1.0";

/** Track an active MCP server so we can disconnect on exit. */
interface ActiveMcpServer {
  name: string;
  client: McpClient;
  /**
   * Slice 9: the registered (definition, handler) entries for this
   * server. Captured here at connect time so subagent registries
   * can re-register the same handlers — the handlers close over the
   * shared McpClient (stdio MCP servers are singletons per chat
   * session per the Slice 7 lock), so subagents and the parent all
   * dispatch through the same client instance.
   */
  entries: readonly McpRegistrationEntry[];
}

/** Track an active subagent's session handle so chat exit can clean
 *  it up if the subagent's spawn_subagent handler didn't get a
 *  chance to run its `finally` block (e.g., process killed
 *  ungracefully). */
interface ActiveSubagent {
  sessionUuid: string;
  handle: SessionHandle;
}

/** Aggregate token usage tracker for the chat-exit diagnostic. */
interface UsageTotals {
  rootInputTokens: number;
  rootOutputTokens: number;
  subagentInputTokens: number;
  subagentOutputTokens: number;
  subagentCount: number;
}

export function registerChat(program: Command, logger: FunClawLogger): void {
  program
    .command("chat")
    .description("start an interactive conversation with the agent")
    .action(async () => {
      await runChatCommand(logger);
    });
}

async function runChatCommand(logger: FunClawLogger): Promise<void> {
  const config = await loadConfig();
  const model = resolveModel(config);
  const provider = createProvider({
    provider: config.provider,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
  });

  const image = config.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  const runner = new DockerRunner({
    image,
    workingDir: config.workingDir ?? process.cwd(),
    networkMode: config.networkMode,
  });

  logger.info({ provider: config.provider, model, image }, "chat command starting");

  // Discover skills (Slice 8) before any heavy work. Per-skill parse
  // failures are warning-only inside discoverSkills and don't throw.
  const discoveredSkills: DiscoveredSkill[] = await discoverSkills({ logger });
  logger.info(
    {
      skillCount: discoveredSkills.length,
      skills: discoveredSkills.map((s) => ({
        name: s.skill.frontmatter.name,
        source: s.source,
        hasScripts: s.skill.scriptsDirectory !== undefined,
      })),
    },
    "skills discovered",
  );

  // Pull / verify the runtime image before constructing the session.
  // FC-1022 on pull failure; FC-1001 if Docker is unreachable.
  await runner.ensureImage({
    onProgress: (status) => {
      logger.debug({ status }, "image pull progress");
    },
  });

  // Build the registry. MCP tools land in here first (so the registry
  // owns the prefixed namespace), then `execute_bash`, `write_file`,
  // and per-skill `skill__<name>` tools join after the container
  // session is created. Either order works; this order makes the
  // warning surface from MCP startup come before the longer
  // container-creation step.
  const registry = new ToolRegistry();

  const activeMcpServers: ActiveMcpServer[] = await connectAllMcpServers(
    config.mcp,
    registry,
    logger,
  );

  // Build the SkillMount list for the runner. One read-only bind
  // mount per skill at /skills/<name>. Empty array means no /skills
  // directory exists in the container at all.
  const skillsMounts: SkillMount[] = discoveredSkills.map((ds) => ({
    name: ds.skill.frontmatter.name,
    hostPath: ds.skill.directory,
  }));

  // Container last so MCP / skills setup failures don't leave a
  // sandbox container hanging.
  const sessionUuid = randomUUID();
  const sessionHandle = await runner.createSession(sessionUuid, skillsMounts);
  logger.info(
    {
      sessionUuid,
      containerId: sessionHandle.containerId,
      skillsMounted: skillsMounts.length,
    },
    "chat session container created",
  );

  // Register `execute_bash` against the live session handle. The
  // handler closes over `sessionHandle` so the agent loop's
  // dispatcher doesn't need to know about Docker — it just calls the
  // registered handler with the parsed tool call.
  const executeBashHandler: ToolHandler = async (toolCall, _context, signal) => {
    const input = parseExecuteBashInput(toolCall.input);
    return runExecuteBashSync(sessionHandle, input, toolCall.id, {
      abortSignal: signal,
    });
  };
  registry.register(executeBashTool, executeBashHandler);

  // Register `write_file` (Slice 8). Same closure pattern as
  // execute_bash; the handler runs inside the same container. Path
  // traversal protection lives in the tool's `resolveWriteFilePath`
  // helper and produces FC-1030 / FC-1031 / FC-1032 on rejection.
  const writeFileHandler: ToolHandler = async (toolCall, _context, signal) => {
    const input = parseWriteFileInput(toolCall.input);
    return runWriteFile(sessionHandle, input, toolCall.id, { abortSignal: signal });
  };
  registry.register(writeFileTool, writeFileHandler);

  // Register one `skill__<name>` tool per discovered skill. The
  // handler returns the skill's markdown body verbatim (per the
  // Slice 8 instruction-module pattern — the agent reads the body
  // and acts on it, typically by running the skill's scripts via
  // execute_bash).
  registerSkillTools(registry, discoveredSkills);

  // ---------------------------------------------------------------
  // Slice 9: spawn_subagent at depth 0 + subagent runtime factory
  // ---------------------------------------------------------------
  //
  // The factory captures (runner, rootSessionUuid, skillsMounts,
  // mcpInheritanceKit, discoveredSkills, provider, model, logger) in
  // closure. Each spawn_subagent invocation:
  //   1. Calls runner.spawnSubagentSession(rootUuid, subUuid, mounts)
  //      to get a fresh ephemeral container.
  //   2. Records the handle in `activeSubagents` so chat-exit cleanup
  //      can destroy it if the spawn_subagent handler's own finally
  //      block didn't fire (process killed, etc.).
  //   3. Builds a fresh registry with: inherited MCP entries (same
  //      handlers — McpClient is shared), inherited skills (static
  //      handlers), fresh execute_bash + write_file bound to the
  //      subagent's container, and (if depth+1 < SUBAGENT_MAX_DEPTH)
  //      a recursive spawn_subagent at depth+1.
  //   4. Returns the cleanup callback that removes the handle from
  //      activeSubagents and destroys the container.
  const activeSubagents: ActiveSubagent[] = [];
  const usageTotals: UsageTotals = {
    rootInputTokens: 0,
    rootOutputTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCount: 0,
  };
  const onSubagentFinished = (info: SubagentFinishedInfo): void => {
    usageTotals.subagentInputTokens += info.inputTokens;
    usageTotals.subagentOutputTokens += info.outputTokens;
    usageTotals.subagentCount += 1;
  };
  // The `_parentDepth` parameter is intentionally unused inside the
  // factory closure (childDepth from the invocation arg is what we
  // act on); it's there for call-site readability so the outer
  // `subagentFactoryAtDepth(0)` reads as "the factory used by a
  // depth-0 parent" rather than a bare invocation.
  const subagentFactoryAtDepth = (_parentDepth: 0 | 1 | 2): SubagentRuntimeFactory => {
    return async ({ childDepth }): Promise<SubagentRuntimeFactoryResult> => {
      const subagentSessionUuid = randomUUID();
      const subagentHandle = await runner.spawnSubagentSession(
        sessionUuid,
        subagentSessionUuid,
        skillsMounts,
      );
      activeSubagents.push({ sessionUuid: subagentSessionUuid, handle: subagentHandle });

      const subagentRegistry = new ToolRegistry();

      // Inherited MCP entries (same handlers — singleton clients).
      for (const active of activeMcpServers) {
        if (active.entries.length > 0) {
          subagentRegistry.registerMcpServer(active.name, active.entries);
        }
      }

      // Inherited skill__<name> tools (static handlers).
      registerSkillTools(subagentRegistry, discoveredSkills);

      // Fresh execute_bash bound to the subagent's container.
      const subagentExecuteBash: ToolHandler = async (toolCall, _ctx, signal) => {
        const input = parseExecuteBashInput(toolCall.input);
        return runExecuteBashSync(subagentHandle, input, toolCall.id, { abortSignal: signal });
      };
      subagentRegistry.register(executeBashTool, subagentExecuteBash);

      // Fresh write_file bound to the subagent's container.
      const subagentWriteFile: ToolHandler = async (toolCall, _ctx, signal) => {
        const input = parseWriteFileInput(toolCall.input);
        return runWriteFile(subagentHandle, input, toolCall.id, { abortSignal: signal });
      };
      subagentRegistry.register(writeFileTool, subagentWriteFile);

      // Recursive spawn_subagent — only if the child's depth allows
      // further nesting. At childDepth = 3 we deliberately do NOT
      // register the tool (the grandchildren-of-children rule from
      // ADR-003).
      if (childDepth < SUBAGENT_MAX_DEPTH) {
        // Narrow childDepth to the parentDepth shape for the
        // recursive factory.
        const nextParentDepth = childDepth as 0 | 1 | 2;
        const recursiveFactory = subagentFactoryAtDepth(nextParentDepth);
        const { definition, handler } = buildSpawnSubagentTool({
          parentDepth: nextParentDepth,
          rootSessionUuid: sessionUuid,
          provider: provider as LLMProvider,
          model,
          logger,
          factory: recursiveFactory,
          onSubagentFinished,
        });
        subagentRegistry.register(definition, handler);
      }

      return {
        registry: subagentRegistry,
        subagentSessionUuid,
        cleanup: async () => {
          // Remove from active list FIRST so a parallel cleanup
          // pass at chat exit doesn't try to destroy this handle
          // again.
          const idx = activeSubagents.findIndex((s) => s.sessionUuid === subagentSessionUuid);
          if (idx >= 0) activeSubagents.splice(idx, 1);
          await runner.destroySession(subagentHandle);
        },
      };
    };
  };

  // Register spawn_subagent at depth 0 (root).
  const rootSubagentFactory = subagentFactoryAtDepth(0);
  const { definition: spawnSubagentDef, handler: spawnSubagentHandler } = buildSpawnSubagentTool({
    parentDepth: 0,
    rootSessionUuid: sessionUuid,
    provider: provider as LLMProvider,
    model,
    logger,
    factory: rootSubagentFactory,
    onSubagentFinished,
  });
  registry.register(spawnSubagentDef, spawnSubagentHandler);

  const systemPrompt = buildSystemPrompt({
    tools: registry.getDefinitions(),
    sessionUuid,
    ...(config.workingDir !== undefined ? { workingDir: config.workingDir } : {}),
    mcpServerNames: registry.getMcpServerNames(),
    skills: discoveredSkills.map((ds) => ({
      name: ds.skill.frontmatter.name,
      description: ds.skill.frontmatter.description,
      source: ds.source,
      hasScripts: ds.skill.scriptsDirectory !== undefined,
    })),
  });

  // Dynamic-import the ESM chat-runtime. Two subtleties wrapped together:
  //
  //   1. Compile-time vs runtime path divergence. The TypeScript source
  //      lives at packages/cli/src/commands/chat.ts; the ESM runtime
  //      source is packages/cli/src/chat-runtime.tsx. NodeNext resolves
  //      `../chat-runtime.js` to that .tsx file for typing purposes.
  //      But at runtime, this CJS file is bundled INTO dist/index.js,
  //      and the ESM runtime is emitted at dist/chat-runtime.mjs — so
  //      the runtime sibling path is `./chat-runtime.mjs`.
  //
  //   2. Tsup / esbuild static analysis. A literal `await import("...")`
  //      gets analyzed at bundle time; we don't want tsup to try to
  //      pull chat-runtime into the CJS bundle (it can't — top-level
  //      await + ESM-only deps). Storing the path in a variable opts
  //      the dynamic import out of static analysis so the string is
  //      preserved verbatim in dist/index.js.
  //
  // The cast carries the type from the source-tree path; the variable
  // carries the runtime path. They look at the same module from
  // different vantage points.
  const runtimeModulePath = "./chat-runtime.mjs";
  const runtime = (await import(runtimeModulePath)) as typeof import("../chat-runtime.js");

  try {
    await runtime.startChatTui({
      provider,
      registry,
      systemPrompt,
      model,
      sessionUuid,
      logger,
      onTurnUsage: (usage) => {
        usageTotals.rootInputTokens += usage.inputTokens;
        usageTotals.rootOutputTokens += usage.outputTokens;
      },
    });
  } finally {
    // Cleanup order (Slice 9): subagent containers first (so any
    // mid-flight subagents from a not-yet-completed spawn_subagent
    // call still get cleaned up), then MCP servers, then the root
    // Docker session. Each loop swallows individual errors so a
    // single failure doesn't block downstream teardown.
    if (activeSubagents.length > 0) {
      logger.info(
        { liveSubagents: activeSubagents.length },
        "destroying live subagent containers (chat exit cleanup)",
      );
      for (const sub of activeSubagents.slice()) {
        try {
          await runner.destroySession(sub.handle);
        } catch (err) {
          logger.warn(
            { subagentSessionUuid: sub.sessionUuid, err },
            "subagent destroy threw at chat-exit cleanup; continuing teardown",
          );
        }
      }
      activeSubagents.length = 0;
    }

    for (const active of activeMcpServers) {
      try {
        logger.info({ serverName: active.name }, "disconnecting MCP server");
        await active.client.disconnect();
      } catch (err) {
        logger.warn({ serverName: active.name, err }, "MCP disconnect threw; continuing teardown");
      }
    }

    logger.info({ sessionUuid }, "destroying chat session");
    await runner.destroySession(sessionHandle);

    // Per ADR-003: tokens charge to root for cost accounting. Log
    // an aggregate at exit so users see the true cost of the
    // chat. Slice 9 keeps this diagnostic-only — Slice 10 polish
    // may add a hard budget cap on the aggregate.
    const totalInput = usageTotals.rootInputTokens + usageTotals.subagentInputTokens;
    const totalOutput = usageTotals.rootOutputTokens + usageTotals.subagentOutputTokens;
    logger.info(
      {
        rootInputTokens: usageTotals.rootInputTokens,
        rootOutputTokens: usageTotals.rootOutputTokens,
        subagentInputTokens: usageTotals.subagentInputTokens,
        subagentOutputTokens: usageTotals.subagentOutputTokens,
        subagentCount: usageTotals.subagentCount,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
      },
      `chat exit token totals: root ${usageTotals.rootInputTokens} in / ${usageTotals.rootOutputTokens} out; ` +
        `${usageTotals.subagentCount} subagent(s) ${usageTotals.subagentInputTokens} in / ${usageTotals.subagentOutputTokens} out; ` +
        `grand total ${totalInput} in / ${totalOutput} out`,
    );
  }
}

/**
 * Bring up every enabled `[mcp.<name>]` server from the config.
 * Per-server failures are logged warnings; the chat session continues
 * with whatever subset succeeded. ADR-001 mandates a one-line warning
 * the first time each MCP server starts because they run on the
 * user's host with the user's privileges, NOT inside the sandbox.
 */
async function connectAllMcpServers(
  mcp: UserConfig["mcp"],
  registry: ToolRegistry,
  logger: FunClawLogger,
): Promise<ActiveMcpServer[]> {
  if (mcp === undefined) return [];

  const active: ActiveMcpServer[] = [];

  for (const [serverName, serverConfig] of Object.entries(mcp)) {
    if (serverConfig === undefined) continue;
    if (serverConfig.enabled === false) {
      logger.info({ serverName }, "MCP server disabled in config; skipping");
      continue;
    }

    // ADR-001 host-trust warning: surface every time a server starts
    // so users grepping logs can correlate. Once-per-session is
    // sufficient because we don't restart servers in v1.
    process.stderr.write(
      `funclaw: MCP server "${serverName}" is starting on the host with your privileges, not inside the sandbox.\n`,
    );

    const client = new McpClient();
    try {
      const result = await client.connect(serverName, toServerConfig(serverConfig));
      logger.info(
        {
          serverName,
          toolCount: result.tools.length,
          toolNames: result.rawTools.map((t) => t.name),
        },
        "MCP server connected",
      );

      // Register each tool. The handler closure captures the (client,
      // server name, original tool name) triple so the agent loop's
      // dispatcher can call the right tool on the right server.
      const entries: McpRegistrationEntry[] = result.rawTools.map((rawTool) => {
        const definition = result.tools.find(
          (d) => d.name === buildPrefixedToolName(serverName, rawTool.name),
        );
        if (definition === undefined) {
          // Shouldn't happen — adapter built both arrays from the
          // same source — but defensive code is cheap.
          throw funClawError({
            code: "FC-9999",
            message: `MCP adapter inconsistency: tool "${rawTool.name}" missing from definitions for server "${serverName}".`,
            data: { serverName, toolName: rawTool.name },
          });
        }
        const handler: ToolHandler = async (toolCall, _ctx, signal) => {
          if (!client.isAlive) {
            throw mcpToolUnavailableError({ serverName, toolName: rawTool.name });
          }
          const inputArgs =
            toolCall.input !== null && typeof toolCall.input === "object"
              ? (toolCall.input as Record<string, unknown>)
              : {};
          const sdkResult = await client.callTool(rawTool.name, inputArgs, signal);
          const formatted = formatMcpCallToolResult(sdkResult);
          return {
            toolUseId: toolCall.id,
            content: formatted.text,
            ...(formatted.isError ? { isError: true as const } : {}),
          };
        };
        return { definition, handler };
      });
      registry.registerMcpServer(serverName, entries);

      // Wire crash detection: on transport close / error, drop the
      // server's tools from the registry and log FC-3004. The chat
      // session continues with remaining tools.
      client.on("crash", (event) => {
        const removed = registry.unregisterMcpServer(serverName);
        logger.warn(
          {
            serverName,
            reason: event.reason,
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            ...(event.signal !== undefined ? { signal: event.signal } : {}),
            removedTools: removed,
          },
          `[FC-3004] MCP server "${serverName}" crashed mid-session; ${removed} tool(s) unregistered`,
        );
      });

      active.push({ name: serverName, client, entries });
    } catch (err) {
      // Per Slice 7 kickoff: per-server failures log a warning and
      // continue. Distinguish FunClawError (we threw it intentionally
      // with a code) from anything else (unexpected; surface as
      // FC-9999 wrapped log).
      if (isFunClawError(err)) {
        logger.warn(
          { serverName, code: err.code, err },
          `[${err.code}] MCP server "${serverName}" failed to start: ${err.message}`,
        );
        process.stderr.write(
          `funclaw: [${err.code}] MCP server "${serverName}" failed to start: ${err.message}\n`,
        );
      } else {
        logger.warn(
          { serverName, err },
          `MCP server "${serverName}" failed to start with an unexpected error`,
        );
        process.stderr.write(
          `funclaw: [FC-9999] MCP server "${serverName}" failed to start; see log for details.\n`,
        );
      }
      // Best-effort cleanup of the half-started client (the McpClient
      // already does this internally on connect failure, but we call
      // again defensively).
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
    }
  }

  return active;
}

/**
 * Register one `skill__<name>` tool per discovered skill (Slice 8).
 * Each handler returns the skill's markdown body verbatim — the
 * "instruction module" pattern from the Slice 8 saved feedback.
 * Skills are registered AFTER MCP and the built-in tools so any
 * collision (an MCP server that picked a name colliding with a
 * skill) surfaces as FC-6004 here, not silently overwriting.
 */
function registerSkillTools(
  registry: ToolRegistry,
  discoveredSkills: readonly DiscoveredSkill[],
): void {
  for (const ds of discoveredSkills) {
    const skill = ds.skill;
    const definition: ToolDefinition = {
      name: `skill__${skill.frontmatter.name}`,
      description:
        `Load the "${skill.frontmatter.name}" skill: ${skill.frontmatter.description} ` +
        `Returns the skill's markdown instructions verbatim. ` +
        (skill.scriptsDirectory !== undefined
          ? `Helper scripts are available read-only at /skills/${skill.frontmatter.name}/scripts/.`
          : "This skill has no helper scripts."),
      // Skills take no arguments; the body is fixed at parse time.
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
    const body = skill.body;
    const handler: ToolHandler = async (toolCall) => {
      return {
        toolUseId: toolCall.id,
        content: body,
      };
    };
    registry.register(definition, handler);
  }
}

/**
 * Map our config-shape `McpServerConfig` to the `ServerConfig` shape
 * the mcp-client package consumes. They are structurally identical
 * but typed in two places (config schema lives in `@funclaw/core`,
 * client lives in `@funclaw/mcp-client`) so this thin shim documents
 * the boundary without forcing a circular dependency.
 */
function toServerConfig(cfg: McpServerConfig): {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
} {
  return {
    command: cfg.command,
    ...(cfg.args !== undefined ? { args: cfg.args } : {}),
    ...(cfg.env !== undefined ? { env: cfg.env } : {}),
    ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
  };
}

function resolveModel(config: UserConfig): string {
  if (config.defaultModel !== undefined && config.defaultModel.length > 0) {
    return config.defaultModel;
  }
  const fallback = DEFAULT_MODEL_BY_PROVIDER[config.provider];
  if (fallback === "") {
    throw funClawError({
      code: "FC-6005",
      message:
        `Provider "${config.provider}" requires a model name; no default is available. ` +
        "Set `defaultModel` in your funclaw config or `FUNCLAW_MODEL` in your environment.",
      data: { provider: config.provider },
    });
  }
  return fallback;
}
