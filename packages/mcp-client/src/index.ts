// Public surface of `@funclaw/mcp-client`.
//
// Slice 7 introduces the MCP integration. Per CLAUDE.md "Slice 1,
// Task 3 saved feedback", the barrel uses explicit named re-exports
// so private helpers in sibling modules don't leak into the public
// API by accident. When you add a new public name, also add it here.
//
// Reference docs:
//   - .claude/CLAUDE.md (slice plan; saved feedback for barrel
//     re-export discipline; Slice 7 pre-decisions).

// Adapter helpers (translate MCP wire shapes ↔ Fun Claw shapes)
export {
  buildPrefixedToolName,
  formatMcpCallToolResult,
  mcpToolToFunClawTool,
} from "./adapter.js";
export type { McpCallToolResult, McpClientOptions } from "./client.js";
// Client class + options
export { DEFAULT_CALL_TIMEOUT_MS, McpClient } from "./client.js";

// Error helpers (FC-3xxx FunClawErrors). Exported so chat.ts and
// tests can construct the same shapes when needed.
export {
  mcpCallTimeoutError,
  mcpCrashError,
  mcpInitError,
  mcpSpawnError,
  mcpStartupTimeoutError,
  mcpToolUnavailableError,
  mcpTransportError,
} from "./errors.js";

// Public types
export type {
  McpConnectResult,
  McpCrashEvent,
  McpCrashReason,
  McpToolMeta,
  ServerConfig,
} from "./types.js";
