// Fun Claw MCP client wrapper.
//
// Wraps `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`
// pair into a Fun Claw-shaped lifecycle:
//
//   - `connect(name, config)` — spawns the subprocess via the SDK's
//     stdio transport, drives the JSON-RPC initialize handshake,
//     queries `tools/list`, and returns Fun Claw `ToolDefinition`s
//     (with the `mcp__<server>__<tool>` prefix already applied).
//     Bounded by a 5-second startup window.
//   - `callTool(toolName, args, signal)` — calls a tool, capped at 30
//     seconds with the caller's AbortSignal threaded into the SDK's
//     RequestOptions. Failures are FC-3xxx FunClawErrors.
//   - `disconnect()` — closes the SDK transport (which kills the
//     subprocess). Idempotent.
//   - `isAlive` — true while the transport is healthy. Flips to false
//     on subprocess exit, transport error, or `disconnect()`.
//   - `crash` event — emitted once per crashed transport, before
//     `isAlive` flips. chat.ts subscribes to drive its
//     `unregisterMcpServer(name)` cleanup branch.
//
// Per ADR-001, MCP servers run on the host with the user's privileges
// — they are NOT inside the Docker sandbox. The chat command surfaces
// a one-line warning at session start; this module focuses purely on
// the lifecycle plumbing.
//
// Per CLAUDE.md "Never `child_process.exec(string)`" — we don't spawn
// directly here; the SDK's `StdioClientTransport` does, and it uses
// `cross-spawn` (an argv-form spawn). We pass argv-form arguments to
// the transport.
//
// Reference docs:
//   - .claude/CLAUDE.md (MCP pre-decisions; FC-3xxx narrow
//     specificity policy).
//   - docs/adr/ADR-001-trust-boundaries.md (MCP servers on host).
//   - REQUIREMENTS.md Flow 4 (MCP server lifecycle).

import { EventEmitter } from "node:events";
import { isFunClawError } from "@funclaw/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpToolToFunClawTool } from "./adapter.js";
import {
  mcpCallTimeoutError,
  mcpCrashError,
  mcpInitError,
  mcpSpawnError,
  mcpStartupTimeoutError,
  mcpToolUnavailableError,
  mcpTransportError,
} from "./errors.js";
import type { McpConnectResult, McpCrashEvent, McpToolMeta, ServerConfig } from "./types.js";

/** 5-second startup cap: spawn + init + first list. */
const STARTUP_TIMEOUT_MS = 5_000;

/** 30-second per-call cap. Configurable per-server later if needed. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Fun Claw client identity advertised over the MCP handshake. Servers
 * sometimes log this; surface a recognizable name + version so users
 * grepping their server logs can identify the connection.
 */
const FUNCLAW_CLIENT_INFO = {
  name: "funclaw",
  // The CLI version is sourced lazily in the bin entry; here we use a
  // static placeholder. MCP `initialize` is per-session so the actual
  // CLI version drift doesn't matter for protocol behavior.
  version: "0.x",
} as const;

export interface McpClientOptions {
  /** Override the per-call timeout. Defaults to 30s. */
  callTimeoutMs?: number;
  /** Override the startup timeout. Defaults to 5s. */
  startupTimeoutMs?: number;
}

/**
 * Structural projection of the SDK's `callTool` result shape onto the
 * fields our adapter consumes. The SDK's actual return type is a
 * discriminated union of the modern `{ content, ... }` shape and the
 * legacy `{ toolResult }` shape; we cast at the SDK boundary because
 * v1 only consumes the modern shape (legacy collapses to an "(empty
 * result)" string in `formatMcpCallToolResult`).
 */
export interface McpCallToolResult {
  content?: ReadonlyArray<unknown>;
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

interface McpClientEventMap {
  crash: [McpCrashEvent];
}

/**
 * Per-server MCP client. Construct, then `connect(name, config)`.
 * After a successful connect, call `callTool(...)` repeatedly. Always
 * `disconnect()` in a `finally` to ensure subprocess cleanup.
 *
 * Crash semantics: if the underlying transport closes unexpectedly
 * (subprocess exit, transport error, broken pipe), the client emits
 * a single `'crash'` event with structured detail and flips
 * `isAlive` to `false`. Any in-flight `callTool` promises will reject
 * with FC-3006 (transport error) or FC-3007 (tool unavailable) when
 * the SDK rejects the underlying request.
 */
export class McpClient extends EventEmitter<McpClientEventMap> {
  private readonly callTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connectedServerName: string | undefined;
  private aliveFlag = false;
  private crashEmitted = false;

  constructor(options: McpClientOptions = {}) {
    super();
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  }

  /**
   * True between a successful `connect()` and `disconnect()` (or a
   * crash). Use this from chat.ts to short-circuit dispatched tool
   * calls when the server died between dispatch and execute.
   */
  get isAlive(): boolean {
    return this.aliveFlag;
  }

  /** Server name from the most recent `connect()`. Useful for logging. */
  get serverName(): string | undefined {
    return this.connectedServerName;
  }

  /**
   * Spawn the MCP server subprocess, perform the JSON-RPC init
   * handshake, and query `tools/list`. Returns the Fun Claw-shaped
   * tool definitions ready to register in the tool registry.
   *
   * Throws:
   *   - FC-3001 — spawn failure (command not found, ENOENT, EACCES).
   *   - FC-3002 — init handshake error (server crashed during init,
   *     malformed protocol).
   *   - FC-3003 — startup timed out (5s by default).
   *   - FC-3006 — transport-level error during the listTools call.
   */
  async connect(serverName: string, config: ServerConfig): Promise<McpConnectResult> {
    if (this.aliveFlag) {
      throw mcpTransportError({
        serverName,
        detail: "client is already connected; call disconnect() first",
      });
    }

    this.connectedServerName = serverName;
    this.crashEmitted = false;

    // Build the transport's parameter object. We avoid spreading
    // `process.env` ourselves — the SDK's `getDefaultEnvironment()`
    // is what fires when `env` is undefined, and it already filters
    // for "safe" inheritance. When the user supplies `env`, we merge
    // it over `process.env` (so the user-supplied vars override the
    // parent's, "additional env vars" per the kickoff) and pass that
    // explicit object so the SDK uses it verbatim.
    const transportEnv = config.env !== undefined ? mergeEnv(process.env, config.env) : undefined;

    this.transport = new StdioClientTransport({
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(transportEnv !== undefined ? { env: transportEnv } : {}),
      // Capture stderr so future doctor work can surface it; for now
      // the transport's default ("inherit") would print to our stderr
      // and confuse the chat TUI. "pipe" detaches and we let it
      // accumulate silently in v1.
      stderr: "pipe",
    });

    this.client = new Client(FUNCLAW_CLIENT_INFO, {
      // No special capabilities advertised on the client side for v1.
      // Sampling, roots, elicitation are all out of scope here.
      capabilities: {},
    });

    // Wire crash detection BEFORE connect() so a fast-failing
    // subprocess (ENOENT) can still produce a structured event.
    this.attachCrashHandlers(serverName);

    // The SDK throws synchronously-rejecting promises with mixed
    // error shapes (Error vs ZodError vs internal). Distinguish:
    //   - ENOENT / EACCES at start() → FC-3001.
    //   - Anything else during connect → FC-3002.
    //   - Timeout via AbortSignal.timeout → FC-3003.
    const startupController = new AbortController();
    const startupTimer: NodeJS.Timeout = setTimeout(() => {
      startupController.abort();
    }, this.startupTimeoutMs);

    try {
      // `client.connect(transport, options)` runs:
      //   1. `transport.start()` — spawns subprocess.
      //   2. `initialize` JSON-RPC request.
      //   3. `notifications/initialized` notification.
      // The whole dance is bounded by the AbortSignal we pass.
      await this.client.connect(this.transport, {
        signal: startupController.signal,
        timeout: this.startupTimeoutMs,
      });

      const listResult = await this.client.listTools(undefined, {
        signal: startupController.signal,
        timeout: this.startupTimeoutMs,
      });

      const rawTools: McpToolMeta[] = listResult.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
      const tools = rawTools.map((t) => mcpToolToFunClawTool(serverName, t));

      this.aliveFlag = true;
      return { serverName, tools, rawTools };
    } catch (err) {
      // Make sure we close any partially-started transport to free
      // the subprocess before re-throwing.
      await this.safeCloseAfterFailure();

      if (startupController.signal.aborted) {
        throw mcpStartupTimeoutError({
          serverName,
          timeoutMs: this.startupTimeoutMs,
        });
      }

      // ENOENT / EACCES surface as Error with a `.code` field set by
      // Node's child_process layer.
      if (isSpawnError(err)) {
        throw mcpSpawnError({
          serverName,
          command: config.command,
          cause: err,
        });
      }

      // Anything else during connect: classify as init error. The
      // 'cause' carries the original SDK / Zod error for debugging.
      throw mcpInitError({ serverName, cause: err });
    } finally {
      clearTimeout(startupTimer);
    }
  }

  /**
   * Call a tool on the connected server. Throws:
   *   - FC-3007 — client is not alive (server crashed earlier).
   *   - FC-3005 — call exceeded the per-call timeout.
   *   - FC-3006 — transport error or other SDK rejection.
   *
   * Returns the raw SDK response; callers convert to
   * `ToolResult.content` via `formatMcpCallToolResult` from
   * `./adapter.js`.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<McpCallToolResult> {
    const serverName = this.connectedServerName ?? "(unconnected)";

    if (!this.aliveFlag || this.client === undefined) {
      throw mcpToolUnavailableError({ serverName, toolName });
    }

    // Combine the caller's signal with our per-call timeout. The SDK
    // honors `RequestOptions.signal` and `RequestOptions.timeout`
    // independently, but we want a unified abort surface so the
    // user's Ctrl-C and the timeout both produce the same kind of
    // FunClawError downstream. AbortSignal.any was added in Node 20+;
    // Node 22 LTS supports it.
    const timeoutController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(() => {
      timeoutController.abort(new Error("FC-3005 timeout"));
    }, this.callTimeoutMs);
    const combined = AbortSignal.any([abortSignal, timeoutController.signal]);

    try {
      // The SDK's callTool typed return is a union of the modern
      // `{ content, structuredContent?, isError? }` shape and a
      // legacy `{ toolResult }` shape. Both are projected onto our
      // `McpCallToolResult` (modern fields optional) for the
      // adapter; the legacy shape collapses to "(empty result)" in
      // formatMcpCallToolResult.
      const result = (await this.client.callTool({ name: toolName, arguments: args }, undefined, {
        signal: combined,
        timeout: this.callTimeoutMs,
      })) as McpCallToolResult;
      return result;
    } catch (err) {
      if (timeoutController.signal.aborted) {
        throw mcpCallTimeoutError({
          serverName,
          toolName,
          timeoutMs: this.callTimeoutMs,
        });
      }
      // If the caller's signal aborted, propagate as a transport
      // error with a clear detail rather than swallowing.
      if (abortSignal.aborted) {
        throw mcpTransportError({
          serverName,
          detail: "tool call aborted by caller",
          cause: err,
        });
      }
      // If the client died mid-call (subprocess exit during the
      // request), surface as FC-3007 specifically — that's the
      // user-actionable signal "your server died, retry won't help."
      if (!this.aliveFlag) {
        throw mcpToolUnavailableError({ serverName, toolName });
      }
      // FunClawErrors pass through (we already produced one above);
      // anything else is an SDK / transport problem.
      if (isFunClawError(err)) throw err;
      throw mcpTransportError({
        serverName,
        detail: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Close the SDK transport (which kills the subprocess) and clear
   * internal state. Idempotent — calling on an already-disconnected
   * client is a no-op.
   */
  async disconnect(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.aliveFlag = false;
    this.transport = undefined;
    this.client = undefined;

    // Closing the SDK Client also closes its transport. We call
    // `client.close()` first if available (drains queued requests),
    // then `transport.close()` as a defense.
    try {
      if (client !== undefined) await client.close();
    } catch {
      // Best-effort: a misbehaving server may have already broken
      // the pipe. Don't let cleanup throw.
    }
    try {
      if (transport !== undefined) await transport.close();
    } catch {
      // ditto
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private attachCrashHandlers(serverName: string): void {
    const transport = this.transport;
    if (transport === undefined) return;

    transport.onclose = () => {
      // `onclose` fires for both clean disconnect and crash. We only
      // emit 'crash' when alive at the time of close — clean
      // disconnect goes through `disconnect()` which clears
      // `aliveFlag` first.
      if (!this.aliveFlag || this.crashEmitted) return;
      this.crashEmitted = true;
      this.aliveFlag = false;
      const evt: McpCrashEvent = { reason: "transport-close" };
      const err = mcpCrashError({
        serverName,
        reason: "transport closed unexpectedly",
      });
      this.emit("crash", { ...evt, error: err });
    };

    transport.onerror = (error: Error) => {
      if (this.crashEmitted) return;
      this.crashEmitted = true;
      this.aliveFlag = false;
      const evt: McpCrashEvent = { reason: "transport-error", error };
      this.emit("crash", evt);
    };
  }

  /**
   * Best-effort cleanup after a failed `connect()`. We don't want a
   * half-spawned subprocess hanging around if init fails, so we close
   * the transport (kills the subprocess) and swallow any error from
   * that close — the caller is already getting a thrown FunClawError
   * for the original failure.
   */
  private async safeCloseAfterFailure(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.aliveFlag = false;
    this.transport = undefined;
    this.client = undefined;
    try {
      if (client !== undefined) await client.close();
    } catch {
      // best-effort
    }
    try {
      if (transport !== undefined) await transport.close();
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Merge user-supplied env over the parent process's env. Keys with
 * undefined values in the parent are dropped (Node's process.env type
 * is `Record<string, string | undefined>`); user-supplied values
 * always override.
 */
function mergeEnv(parent: NodeJS.ProcessEnv, user: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (typeof v === "string") out[k] = v;
  }
  for (const [k, v] of Object.entries(user)) {
    out[k] = v;
  }
  return out;
}

/**
 * True if `err` looks like a Node `child_process` spawn failure
 * (ENOENT, EACCES, EPERM). The SDK's `transport.start()` doesn't
 * wrap these — they propagate as standard Node Errors with a `.code`
 * field. We detect by code rather than by `instanceof` since the SDK
 * may rewrap in the future.
 */
function isSpawnError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}
