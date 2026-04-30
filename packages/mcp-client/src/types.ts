// Public types for `@funclaw/mcp-client`.
//
// The shapes here are the surface area consumed by the chat command
// (`packages/cli/src/commands/chat.ts`) and the tool registry
// (`packages/core/src/tool-registry.ts`).
//
// Reference docs:
//   - .claude/CLAUDE.md (MCP pre-decisions: stdio-only, prefix
//     format, server-failure isolation, FC-3xxx allocation).
//   - REQUIREMENTS.md Flow 4 (MCP server configuration shape).
//   - docs/adr/ADR-001-trust-boundaries.md ("MCP servers run on the
//     host with the user's privileges" — host trust boundary).

import type { ToolDefinition } from "@funclaw/core";

/**
 * Configuration for a single MCP server, as the user writes it in
 * `funclaw.config.toml` under `[mcp.<name>]` tables. The server name
 * (the table key) is supplied separately by the caller.
 *
 * Schema:
 *   - `command` is required: the executable to spawn.
 *   - `args` is optional: extra argv items.
 *   - `env` is optional: env vars merged ON TOP OF the parent's env
 *     when the subprocess is spawned. `undefined` means "inherit
 *     parent env unchanged."
 *   - `enabled` defaults to `true`. Useful for users who want to
 *     temporarily disable a server without removing the table.
 */
export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

/**
 * Single tool advertised by an MCP server, normalized into a flat
 * shape for adapter use. The `inputSchema` is the JSON Schema 2020-12
 * fragment the SDK returns from `client.listTools()`.
 */
export interface McpToolMeta {
  /** The server's locally-advertised tool name (NOT prefixed). */
  name: string;
  description: string | undefined;
  /** JSON Schema 2020-12. May be a "type: object" object schema; the
   *  agent loop publishes this to the LLM provider as-is. */
  inputSchema: Record<string, unknown>;
}

/**
 * Result of a successful `McpClient.connect()` call. The `tools` array
 * carries Fun Claw `ToolDefinition`s with the `mcp__<server>__<tool>`
 * prefix already applied — these are ready to register in the tool
 * registry.
 */
export interface McpConnectResult {
  /** The server name as registered in the user's config (the table key). */
  serverName: string;
  /** Tool definitions with `mcp__<server>__<tool>` names. */
  tools: ToolDefinition[];
  /** The raw advertised tools, untouched, in case a caller wants to
   *  surface extra metadata in logs / doctor output. */
  rawTools: McpToolMeta[];
}

/**
 * Possible reasons the underlying transport closed. Surfaced via the
 * 'crash' event so chat.ts can pick the right log message and the
 * right cleanup branch.
 */
export type McpCrashReason = "subprocess-exit" | "transport-error" | "transport-close";

export interface McpCrashEvent {
  reason: McpCrashReason;
  /** Subprocess exit code if known, else undefined. */
  exitCode?: number;
  /** Subprocess signal if known, else undefined. */
  signal?: NodeJS.Signals;
  /** Underlying error from the SDK transport, if any. */
  error?: Error;
}
