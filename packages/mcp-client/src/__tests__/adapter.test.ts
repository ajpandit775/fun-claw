// Vitest tests for the MCP adapter helpers.
//
// `buildPrefixedToolName`, `mcpToolToFunClawTool`, and
// `formatMcpCallToolResult` are pure functions; this suite exercises
// each branch the SDK's response shapes can hit (text / image / audio
// / resource / resource_link / unknown).

import { describe, expect, it } from "vitest";
import {
  buildPrefixedToolName,
  formatMcpCallToolResult,
  mcpToolToFunClawTool,
} from "../adapter.js";

describe("buildPrefixedToolName", () => {
  it("builds mcp__<server>__<tool> verbatim", () => {
    expect(buildPrefixedToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
    expect(buildPrefixedToolName("github", "list-prs")).toBe("mcp__github__list-prs");
  });
});

describe("mcpToolToFunClawTool", () => {
  it("applies the prefix and preserves description + inputSchema", () => {
    const def = mcpToolToFunClawTool("filesystem", {
      name: "read_file",
      description: "Read a file from the host.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
    expect(def.name).toBe("mcp__filesystem__read_file");
    expect(def.description).toBe("Read a file from the host.");
    expect(def.inputSchema).toStrictEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("supplies a fallback description when the MCP tool omits one", () => {
    const def = mcpToolToFunClawTool("foo", {
      name: "bar",
      description: undefined,
      inputSchema: { type: "object" },
    });
    expect(def.description).toContain("(MCP tool from server");
    expect(def.description).toContain("foo");
  });
});

describe("formatMcpCallToolResult — content type handling", () => {
  it("flattens text parts verbatim", () => {
    const r = formatMcpCallToolResult({
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    });
    expect(r.text).toBe("first line\nsecond line");
    expect(r.isError).toBe(false);
  });

  it("returns isError=true when the SDK result carries it", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "text", text: "error message from server" }],
      isError: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("error message from server");
  });

  it("emits a placeholder for image parts", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "image", data: "base64...", mimeType: "image/png" }],
    });
    expect(r.text).toContain("[image (image/png)");
    expect(r.text).toContain("multi-modal");
  });

  it("emits a placeholder for audio parts", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "audio", data: "base64...", mimeType: "audio/wav" }],
    });
    expect(r.text).toContain("[audio (audio/wav)");
  });

  it("emits inline text for resource parts that carry text", () => {
    const r = formatMcpCallToolResult({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///etc/hosts",
            text: "127.0.0.1 localhost",
            mimeType: "text/plain",
          },
        },
      ],
    });
    expect(r.text).toContain("[resource file:///etc/hosts]");
    expect(r.text).toContain("127.0.0.1 localhost");
  });

  it("emits a placeholder for resource parts with binary content", () => {
    const r = formatMcpCallToolResult({
      content: [
        {
          type: "resource",
          resource: {
            uri: "data:image/png;base64,abc",
            blob: "abc...",
            mimeType: "image/png",
          },
        },
      ],
    });
    expect(r.text).toContain("[resource data:image/png");
    expect(r.text).toContain("binary blob omitted");
  });

  it("emits a uri marker for resource_link parts", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "resource_link", uri: "https://example.com/foo", name: "foo" }],
    });
    expect(r.text).toContain("[resource_link https://example.com/foo");
    expect(r.text).toContain('"foo"');
  });

  it("falls back to a generic marker for unknown content types", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "future_unknown_kind", weirdField: 42 } as unknown as never],
    });
    expect(r.text).toContain("[unsupported content type");
  });

  it("appends structuredContent in JSON form when present", () => {
    const r = formatMcpCallToolResult({
      content: [{ type: "text", text: "summary line" }],
      structuredContent: { tally: 42, items: ["a", "b"] },
    });
    expect(r.text).toContain("summary line");
    expect(r.text).toContain("[structured]");
    expect(r.text).toContain('"tally": 42');
  });

  it("returns '(empty result)' when content array is missing or empty", () => {
    expect(formatMcpCallToolResult({}).text).toBe("(empty result)");
    expect(formatMcpCallToolResult({ content: [] }).text).toBe("(empty result)");
  });

  it("handles a content entry that is null gracefully", () => {
    const r = formatMcpCallToolResult({
      content: [null as unknown as never],
    });
    expect(r.text).toContain("[unrecognized content");
  });

  it("handles a content entry without a type field", () => {
    const r = formatMcpCallToolResult({
      content: [{ noType: true } as unknown as never],
    });
    expect(r.text).toContain("[content without type");
  });
});
