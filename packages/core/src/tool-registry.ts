// Fun Claw tool registry.
//
// A simple registry mapping tool names to their `ToolDefinition`
// (forwarded to the LLM in the `tools` parameter of provider streams)
// and `ToolHandler` (invoked by the agent loop's dispatcher).
//
// Not a singleton: the chat command constructs a registry per session
// and registers the tools that session needs (Slice 6: just
// `execute_bash`; Slice 7 adds MCP-namespaced tools; Slice 8 adds skill
// scripts and `write_file`; Slice 9 adds `spawn_subagent`). Different
// commands can register different tool sets — `funclaw skill validate`
// (Slice 8) might register no tools at all.
//
// Reference docs:
//   - docs/adr/ADR-002-tool-dispatch.md (the agent loop iterates the
//     registry's definitions to advertise tools to the LLM, then looks
//     up handlers by name when dispatching).

import { funClawError } from "./errors.js";
import type { ToolDefinition, ToolHandler } from "./types.js";

interface RegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  /**
   * MCP server name when this entry came from an MCP source, else
   * undefined. Used by `unregisterMcpServer(name)` to find the
   * subset of entries to drop on a server crash. Built-in tools
   * (registered via plain `register`) leave this undefined.
   */
  mcpServerName?: string;
}

/**
 * Shape of a single MCP-derived tool, matching the result
 * `@funclaw/mcp-client` produces from `client.listTools()` after the
 * `mcp__<server>__<tool>` prefix is applied. Kept loose
 * (`ToolDefinition` only) so the registry doesn't depend on the
 * mcp-client package — only the chat command, which already does.
 */
export interface McpRegistrationEntry {
  /** Prefixed name (`mcp__<server>__<tool>`). */
  definition: ToolDefinition;
  /** Handler that calls into the underlying McpClient. */
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegistryEntry>();

  /**
   * Register a tool. Throws `FC-6004` if `definition.name` is already
   * registered — silent overwrite would mask a real bug (two tools
   * trying to claim the same name). Callers can `unregister` first if
   * they genuinely want to replace.
   */
  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw funClawError({
        code: "FC-6004",
        message: `Tool "${definition.name}" is already registered. Unregister first if replacement is intended.`,
        data: { name: definition.name },
      });
    }
    this.tools.set(definition.name, { definition, handler });
  }

  /** Remove a tool by name. Idempotent — no-op if not present. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Look up a handler by name. Returns `undefined` if not registered;
   *  the agent loop converts that into an `FC-6003` `ToolResult`. */
  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  /**
   * Snapshot of all registered tool definitions, suitable for passing
   * to `provider.stream({ tools })`. Callers should not mutate the
   * returned array — it's a fresh copy but the inner objects are
   * shared with the registry.
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values(), (entry) => entry.definition);
  }

  /** True if `name` is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Register all tools from a single MCP server in one shot. Each
   * entry's `definition.name` MUST already carry the
   * `mcp__<serverName>__<tool>` prefix — the registry doesn't
   * re-prefix; the mcp-client adapter does that and passes definitions
   * through verbatim.
   *
   * Throws `FC-6004` (duplicate registration) if any incoming name
   * collides with a pre-existing tool. Atomicity: this is a "try the
   * first, throw if it collides" registration — partial registration
   * is possible if a later entry collides. Callers (the chat command)
   * are expected to either (a) register MCP servers BEFORE built-in
   * tools that share the prefix space, or (b) ensure user-chosen
   * server names don't collide with each other.
   */
  registerMcpServer(serverName: string, entries: readonly McpRegistrationEntry[]): void {
    for (const entry of entries) {
      if (this.tools.has(entry.definition.name)) {
        throw funClawError({
          code: "FC-6004",
          message: `Tool "${entry.definition.name}" is already registered. Unregister first if replacement is intended.`,
          data: { name: entry.definition.name, serverName },
        });
      }
      this.tools.set(entry.definition.name, {
        definition: entry.definition,
        handler: entry.handler,
        mcpServerName: serverName,
      });
    }
  }

  /**
   * Remove all tools registered under a specific MCP server name.
   * Used by chat.ts on the 'crash' event to disable a dead server's
   * tools without affecting other servers or built-ins. Idempotent —
   * silently no-ops if no entries match.
   *
   * Returns the number of tools removed (useful for logging the
   * cleanup at chat.ts).
   */
  unregisterMcpServer(serverName: string): number {
    let removed = 0;
    for (const [name, entry] of this.tools.entries()) {
      if (entry.mcpServerName === serverName) {
        this.tools.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Names of MCP servers that currently contribute at least one tool.
   * Used by `buildSystemPrompt` to decide whether to include the
   * MCP-trust-boundary paragraph in the system prompt and which
   * server names to mention.
   */
  getMcpServerNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.tools.values()) {
      if (entry.mcpServerName !== undefined) {
        names.add(entry.mcpServerName);
      }
    }
    return Array.from(names).sort();
  }
}
