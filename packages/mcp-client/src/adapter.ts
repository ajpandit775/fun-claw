// Adapter helpers between the MCP SDK's wire shapes and Fun Claw's
// internal `ToolDefinition` / `ToolResult` shapes.
//
// Two conversions live here:
//
//   1. `mcpToolToFunClawTool` — the LLM-facing direction. Takes a
//      single tool descriptor from `client.listTools()` and returns
//      a `ToolDefinition` with the locked `mcp__<server>__<tool>`
//      prefix applied (per the Slice 7 kickoff).
//
//   2. `formatMcpCallToolResult` — the LLM-feeding direction. Takes
//      the structured `content[]` array from `client.callTool()` and
//      flattens it to a single string suitable for
//      `ToolResult.content`. Text parts pass through verbatim; image
//      / audio / resource parts collapse to short placeholders (full
//      multi-modal handling is out of v1 scope per REQUIREMENTS.md).
//
// Reference docs:
//   - .claude/CLAUDE.md (Slice 7 pre-decisions: prefix format).
//   - REQUIREMENTS.md Flow 4 (`mcp__<server>__<tool>` namespacing).
//   - docs/adr/ADR-001-trust-boundaries.md (tool output is adversarial
//     on the next turn — no escaping here, the system prompt's
//     boundary-marker contract is the defense).

import type { JSONSchema, ToolDefinition } from "@funclaw/core";
import type { McpToolMeta } from "./types.js";

/**
 * Compute the prefixed tool name for a (server, tool) pair. Exposed
 * separately so chat.ts and the registry can construct the same key
 * without duplicating the format string.
 */
export function buildPrefixedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Convert a single MCP-advertised tool to Fun Claw's `ToolDefinition`
 * shape. Output `name` is `mcp__<serverName>__<tool.name>`. The MCP
 * `inputSchema` is typed as `Record<string, unknown>` from the SDK; we
 * cast to `JSONSchema` (which is also `Record<string, unknown>` per
 * `@funclaw/core`'s deliberately loose type) without further
 * validation. The agent loop and provider adapters will surface any
 * malformed schema downstream as a provider-side `tools` error.
 */
export function mcpToolToFunClawTool(serverName: string, tool: McpToolMeta): ToolDefinition {
  return {
    name: buildPrefixedToolName(serverName, tool.name),
    description: tool.description ?? `(MCP tool from server "${serverName}")`,
    inputSchema: tool.inputSchema as JSONSchema,
  };
}

/**
 * MCP `client.callTool()` returns a result with a structured
 * `content` array of mixed types (text, image, audio, resource,
 * resource_link). The agent loop's `ToolResult.content` is a single
 * string. This helper flattens.
 *
 * Rules:
 *   - Text parts: emitted verbatim (no escaping; ADR-001 boundary
 *     markers are applied by the agent loop later).
 *   - Image / audio: collapsed to a short placeholder mentioning the
 *     mimeType. Multi-modal LLM input is `[v2-or-never]` for v1.
 *   - Resource (embedded text or blob): text resources emit their
 *     text; blobs emit a placeholder with the URI and mimeType.
 *   - Resource links: emit the URI.
 *   - Unknown types: emit a placeholder with the type tag.
 *
 * The `structuredContent` field (when present) is appended in JSON
 * form so the LLM can see structured tool output without needing
 * cross-content correlation.
 */
export function formatMcpCallToolResult(result: {
  content?: ReadonlyArray<unknown>;
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}): { text: string; isError: boolean } {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    parts.push(formatBlock(block));
  }
  if (result.structuredContent !== undefined) {
    parts.push(`[structured]\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }
  // Empty results are valid (some tools succeed silently). Surface a
  // short marker so the LLM doesn't see a blank tool_result body.
  const text = parts.length > 0 ? parts.join("\n") : "(empty result)";
  return { text, isError: result.isError === true };
}

function formatBlock(block: unknown): string {
  if (block === null || typeof block !== "object") {
    return `[unrecognized content: ${JSON.stringify(block)}]`;
  }
  const b = block as { type?: unknown };
  if (typeof b.type !== "string") {
    return `[content without type: ${JSON.stringify(block)}]`;
  }
  switch (b.type) {
    case "text": {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "(empty text)";
    }
    case "image": {
      const mime = (block as { mimeType?: unknown }).mimeType;
      return `[image (${typeof mime === "string" ? mime : "unknown mime"}) — multi-modal LLM input is out of scope for v1]`;
    }
    case "audio": {
      const mime = (block as { mimeType?: unknown }).mimeType;
      return `[audio (${typeof mime === "string" ? mime : "unknown mime"}) — multi-modal LLM input is out of scope for v1]`;
    }
    case "resource": {
      const resource = (block as { resource?: unknown }).resource;
      if (resource !== null && typeof resource === "object") {
        const r = resource as { uri?: unknown; text?: unknown; mimeType?: unknown };
        if (typeof r.text === "string") {
          const uri = typeof r.uri === "string" ? r.uri : "(no uri)";
          return `[resource ${uri}]\n${r.text}`;
        }
        const uri = typeof r.uri === "string" ? r.uri : "(no uri)";
        const mime = typeof r.mimeType === "string" ? r.mimeType : "unknown mime";
        return `[resource ${uri} (${mime}, binary blob omitted)]`;
      }
      return "[resource (malformed)]";
    }
    case "resource_link": {
      const uri = (block as { uri?: unknown }).uri;
      const name = (block as { name?: unknown }).name;
      const uriStr = typeof uri === "string" ? uri : "(no uri)";
      const nameStr = typeof name === "string" ? ` "${name}"` : "";
      return `[resource_link ${uriStr}${nameStr}]`;
    }
    default:
      return `[unsupported content type "${b.type}"]`;
  }
}
