// FC-3xxx error helpers for `@funclaw/mcp-client`.
//
// Per CLAUDE.md "Error handling contract", every shipped FC code needs
// a `docs/troubleshooting.md` entry before slice close. The helpers
// below are the canonical construction sites — search for these names
// to know exactly which FC-3xxx codes are live in the codebase.
//
// Reference docs:
//   - .claude/CLAUDE.md "Saved feedback ... Slice 3 — FC-2xxx codes
//     are scoped narrowly: host-side vs wire-side." Same narrow
//     specificity carries over to FC-3xxx: distinct user-facing
//     failure modes get distinct codes.

import { type FunClawError, funClawError } from "@funclaw/core";

// All helpers return `Error & FunClawError` to match what
// `funClawError` actually constructs (the runtime value is an Error
// with the FunClawError fields attached). Returning the broader type
// at the helper boundary gives callers a proper Error (stack, name,
// instanceof) while still exposing `.code` / `.data` / `.cause`.
type FCError = Error & FunClawError;

/**
 * FC-3001 — MCP server failed to spawn (command not found, permission
 * denied, ENOENT). The user wrote a `command` field in their config
 * that the OS could not execute.
 */
export function mcpSpawnError(args: {
  serverName: string;
  command: string;
  cause: unknown;
}): FCError {
  return funClawError({
    code: "FC-3001",
    message:
      `MCP server "${args.serverName}" failed to spawn: ` +
      `command "${args.command}" could not be executed. ` +
      "Check that the command exists on PATH or use an absolute path.",
    cause: args.cause,
    data: { serverName: args.serverName, command: args.command },
  });
}

/**
 * FC-3002 — MCP server initialization failed. The subprocess started
 * but the JSON-RPC handshake (`initialize` / `initialized`) did not
 * complete successfully. Usually the server crashed during init or
 * sent malformed responses.
 */
export function mcpInitError(args: { serverName: string; cause: unknown }): FCError {
  return funClawError({
    code: "FC-3002",
    message:
      `MCP server "${args.serverName}" started but the protocol ` +
      `initialization handshake failed. The server may have crashed ` +
      "during init or returned malformed JSON-RPC.",
    cause: args.cause,
    data: { serverName: args.serverName },
  });
}

/**
 * FC-3003 — MCP server startup timeout. The 5-second cap covers the
 * full connect-and-list dance: subprocess spawn → init handshake →
 * `tools/list` response. Beyond that we give up and move on.
 */
export function mcpStartupTimeoutError(args: { serverName: string; timeoutMs: number }): FCError {
  return funClawError({
    code: "FC-3003",
    message:
      `MCP server "${args.serverName}" did not finish startup within ` +
      `${args.timeoutMs}ms. Initialization, capability negotiation, and ` +
      "the first tools/list must all complete inside this window.",
    data: { serverName: args.serverName, timeoutMs: args.timeoutMs },
  });
}

/**
 * FC-3004 — MCP server crashed mid-session. Surfaces from the 'crash'
 * event when the subprocess exits unexpectedly OR the SDK transport
 * reports a fatal error. chat.ts uses this to log the failure and
 * unregister the server's tools from the registry.
 */
export function mcpCrashError(args: {
  serverName: string;
  reason: string;
  exitCode?: number;
  signal?: string;
  cause?: unknown;
}): FCError {
  const detail = args.signal
    ? `signal=${args.signal}`
    : args.exitCode !== undefined
      ? `exit code ${args.exitCode}`
      : args.reason;
  return funClawError({
    code: "FC-3004",
    message:
      `MCP server "${args.serverName}" crashed mid-session (${detail}). ` +
      "Its tools have been unregistered. The session continues; remaining " +
      "tools and any other MCP servers are unaffected.",
    ...(args.cause !== undefined ? { cause: args.cause } : {}),
    data: {
      serverName: args.serverName,
      reason: args.reason,
      ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    },
  });
}

/**
 * FC-3005 — MCP tool call timeout. The 30-second per-call cap fired
 * before the server returned a response. The agent loop converts this
 * into a `tool_result` with `isError: true` so the LLM can adapt.
 */
export function mcpCallTimeoutError(args: {
  serverName: string;
  toolName: string;
  timeoutMs: number;
}): FCError {
  return funClawError({
    code: "FC-3005",
    message:
      `MCP tool "${args.toolName}" on server "${args.serverName}" did not ` +
      `respond within ${args.timeoutMs}ms. Consider chunking long-running ` +
      "operations server-side; Fun Claw will not wait forever.",
    data: {
      serverName: args.serverName,
      toolName: args.toolName,
      timeoutMs: args.timeoutMs,
    },
  });
}

/**
 * FC-3006 — MCP transport error (JSON-RPC malformed, broken pipe, send
 * failed, etc.). Used both during `callTool` and as a wrapper around
 * unexpected SDK errors that aren't init / timeout / crash.
 */
export function mcpTransportError(args: {
  serverName: string;
  detail: string;
  cause?: unknown;
}): FCError {
  return funClawError({
    code: "FC-3006",
    message: `MCP transport error talking to server "${args.serverName}": ` + `${args.detail}.`,
    ...(args.cause !== undefined ? { cause: args.cause } : {}),
    data: { serverName: args.serverName, detail: args.detail },
  });
}

/**
 * FC-3007 — MCP tool not available because the underlying client died
 * earlier in this session. Defensive code path: chat.ts unregisters
 * crashed servers' tools, so this fires only if the registry and the
 * client get out of sync (race during crash handling, or a future
 * caller forgets to unregister).
 */
export function mcpToolUnavailableError(args: { serverName: string; toolName: string }): FCError {
  return funClawError({
    code: "FC-3007",
    message:
      `MCP tool "${args.toolName}" is not available: the underlying server ` +
      `"${args.serverName}" crashed or disconnected earlier in this session.`,
    data: { serverName: args.serverName, toolName: args.toolName },
  });
}
