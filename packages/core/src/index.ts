// Public surface of @funclaw/core.
//
// The pure-logic side of Fun Claw lives here: agent loop, message
// types, provider abstraction, dispatcher, structured logger, and
// configuration. The chat command's TUI lives in `@funclaw/cli`.
//
// Named re-exports (alphabetical within each block) so the public API
// surface is explicit. When you add a new public name to a sibling
// module, also add it to one of the lists below. Relative re-exports
// include `.js` extensions because tsconfig uses `module: NodeNext`.

// Agent loop
export type { AgentLoopOptions } from "./agent-loop.js";
export { runAgentLoop } from "./agent-loop.js";

// Config types
export type {
  GetSecretOptions,
  Keyfile,
  LoadConfigOptions,
  McpConfig,
  McpServerConfig,
  NetworkMode,
  Provider,
  UserConfig,
} from "./config.js";
export {
  getDefaultKeyfilePath,
  getDefaultUserConfigPath,
  getSecret,
  KeyfileSchema,
  LogLevelSchema,
  loadConfig,
  McpConfigSchema,
  McpServerConfigSchema,
  NetworkModeSchema,
  ProviderSchema,
  UserConfigSchema,
} from "./config.js";

// Errors
export type { FunClawErrorInit } from "./errors.js";
export { funClawError, isFunClawError } from "./errors.js";

// Logger types and runtime
export type { FunClawLogger, LoggerOptions, LogLevel } from "./logger.js";
export { createLogger, maskSecret } from "./logger.js";
// Provider factory + adapter classes
export type { CreateProviderInput } from "./provider/index.js";
export {
  AnthropicProvider,
  createProvider,
  GeminiProvider,
  OpenAIProvider,
} from "./provider/index.js";
// Provider types (interface, event union, capabilities, error helpers)
export type {
  LLMProvider,
  MalformedResponseErrorContext,
  MessageStartEvent,
  MessageStopEvent,
  ProviderCapabilities,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorContext,
  ProviderErrorEvent,
  ProviderEvent,
  RateLimitErrorContext,
  StreamOptions,
  TextDeltaEvent,
  TextStopEvent,
  ToolUseDeltaEvent,
  ToolUseStartEvent,
  ToolUseStopEvent,
  UsageTokens,
} from "./provider.js";
export {
  providerAuthError,
  providerMalformedResponseError,
  providerRateLimitError,
  providerUnavailableError,
} from "./provider.js";

// System prompt builder (skills + subagent framing)
export type {
  SubagentPromptContext,
  SystemPromptOptions,
  SystemPromptSkill,
} from "./system-prompt.js";
export { buildSystemPrompt } from "./system-prompt.js";

// Tool registry (built-ins + MCP integration)
export type { McpRegistrationEntry } from "./tool-registry.js";
export { ToolRegistry } from "./tool-registry.js";

// spawn_subagent built-in (per ADR-003)
export type {
  SpawnSubagentDeps,
  SpawnSubagentInput,
  SubagentExitReason,
  SubagentFinishedInfo,
  SubagentRuntimeFactory,
  SubagentRuntimeFactoryResult,
} from "./tools/spawn-subagent.js";
export {
  buildSpawnSubagentDefinition,
  buildSpawnSubagentHandler,
  buildSpawnSubagentTool,
  parseSpawnSubagentInput,
  SpawnSubagentInputSchema,
  SUBAGENT_GOAL_MAX_CHARS,
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_MAX_ITERATIONS,
  SUBAGENT_MAX_TOKENS,
  SUBAGENT_TIMEOUT_MS,
} from "./tools/spawn-subagent.js";

// Conversation, tool, and error types (from types.ts)
export type {
  AgentEvent,
  AgentStopReason,
  AgentUsage,
  ContentBlock,
  FunClawError,
  FunClawErrorCode,
  JSONSchema,
  Message,
  Role,
  StopReason,
  TextBlock,
  ToolCall,
  ToolDefinition,
  ToolHandler,
  ToolHandlerContext,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
