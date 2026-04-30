// Vitest tests for `ToolRegistry`.
//
// Slice 8 brings tests online for the first time (vitest was scaffolded
// in Slice 1 with `passWithNoTests: true`). Per the Slice 8 kickoff:
// "demonstrate the testing pattern works and write meaningful coverage
// on the lowest-risk modules. Slice 10 polish hits the targets."

import { describe, expect, it } from "vitest";
import { isFunClawError } from "../errors.js";
import { type McpRegistrationEntry, ToolRegistry } from "../tool-registry.js";
import type { ToolDefinition, ToolHandler, ToolResult } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function makeHandler(name: string): ToolHandler {
  return async (toolCall): Promise<ToolResult> => {
    return { toolUseId: toolCall.id, content: `${name} ran with id ${toolCall.id}` };
  };
}

function makeMcpEntry(serverName: string, toolName: string): McpRegistrationEntry {
  const prefixed = `mcp__${serverName}__${toolName}`;
  return {
    definition: makeTool(prefixed),
    handler: makeHandler(prefixed),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRegistry — built-in tools", () => {
  it("registers a tool and looks up its handler", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("execute_bash"), makeHandler("execute_bash"));

    expect(reg.size).toBe(1);
    expect(reg.has("execute_bash")).toBe(true);
    expect(reg.getHandler("execute_bash")).toBeDefined();
    expect(reg.getHandler("never_registered")).toBeUndefined();
  });

  it("getDefinitions returns all registered tools in stable order", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("alpha"), makeHandler("alpha"));
    reg.register(makeTool("beta"), makeHandler("beta"));
    reg.register(makeTool("gamma"), makeHandler("gamma"));

    const defs = reg.getDefinitions();
    expect(defs.map((d) => d.name)).toStrictEqual(["alpha", "beta", "gamma"]);
  });

  it("rejects duplicate registration with FC-6004", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("execute_bash"), makeHandler("execute_bash"));

    let caught: unknown;
    try {
      reg.register(makeTool("execute_bash"), makeHandler("execute_bash-2"));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-6004");
      expect(caught.data).toMatchObject({ name: "execute_bash" });
    }
  });

  it("unregister removes a tool and is idempotent", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("foo"), makeHandler("foo"));

    reg.unregister("foo");
    expect(reg.has("foo")).toBe(false);
    expect(reg.size).toBe(0);

    // Idempotent — second call is a no-op.
    reg.unregister("foo");
    reg.unregister("never_registered");
    expect(reg.size).toBe(0);
  });
});

describe("ToolRegistry — MCP integration", () => {
  it("registerMcpServer registers all entries and getMcpServerNames lists them", () => {
    const reg = new ToolRegistry();
    reg.registerMcpServer("filesystem", [
      makeMcpEntry("filesystem", "read_file"),
      makeMcpEntry("filesystem", "write_file"),
    ]);
    reg.registerMcpServer("github", [makeMcpEntry("github", "list_repos")]);

    expect(reg.size).toBe(3);
    expect(reg.has("mcp__filesystem__read_file")).toBe(true);
    expect(reg.has("mcp__filesystem__write_file")).toBe(true);
    expect(reg.has("mcp__github__list_repos")).toBe(true);
    expect(reg.getMcpServerNames()).toStrictEqual(["filesystem", "github"]);
  });

  it("unregisterMcpServer removes only the named server's tools and returns count", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("execute_bash"), makeHandler("execute_bash"));
    reg.registerMcpServer("filesystem", [
      makeMcpEntry("filesystem", "read_file"),
      makeMcpEntry("filesystem", "list_dir"),
    ]);
    reg.registerMcpServer("github", [makeMcpEntry("github", "list_repos")]);
    expect(reg.size).toBe(4);

    const removed = reg.unregisterMcpServer("filesystem");
    expect(removed).toBe(2);
    expect(reg.size).toBe(2);
    expect(reg.has("execute_bash")).toBe(true); // built-in untouched
    expect(reg.has("mcp__github__list_repos")).toBe(true);
    expect(reg.has("mcp__filesystem__read_file")).toBe(false);

    // Idempotent — unregistering twice is fine.
    expect(reg.unregisterMcpServer("filesystem")).toBe(0);

    // getMcpServerNames updates to reflect the remaining server.
    expect(reg.getMcpServerNames()).toStrictEqual(["github"]);
  });

  it("registerMcpServer collision against built-in tool throws FC-6004", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("mcp__foo__bar"), makeHandler("oops"));

    let caught: unknown;
    try {
      reg.registerMcpServer("foo", [makeMcpEntry("foo", "bar")]);
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-6004");
      expect(caught.data).toMatchObject({ serverName: "foo" });
    }
  });

  it("getMcpServerNames is empty when no MCP tools are registered", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("execute_bash"), makeHandler("execute_bash"));
    expect(reg.getMcpServerNames()).toStrictEqual([]);
  });
});

describe("ToolRegistry — skill integration (skills register as plain tools)", () => {
  it("a skill__<name> tool registers via plain register and is NOT counted as an MCP source", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("skill__git_helper"), makeHandler("skill__git_helper"));

    expect(reg.has("skill__git_helper")).toBe(true);
    // Skills aren't MCP — getMcpServerNames stays empty.
    expect(reg.getMcpServerNames()).toStrictEqual([]);
  });

  it("a skill__<name> can coexist with mcp__<server>__<tool>", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("execute_bash"), makeHandler("execute_bash"));
    reg.register(makeTool("skill__git_helper"), makeHandler("skill__git_helper"));
    reg.registerMcpServer("filesystem", [makeMcpEntry("filesystem", "read_file")]);

    expect(reg.size).toBe(3);
    expect(
      reg
        .getDefinitions()
        .map((d) => d.name)
        .sort(),
    ).toStrictEqual(["execute_bash", "mcp__filesystem__read_file", "skill__git_helper"]);
    expect(reg.getMcpServerNames()).toStrictEqual(["filesystem"]);
  });

  it("skill name collision against another skill throws FC-6004", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("skill__git_helper"), makeHandler("v1"));

    let caught: unknown;
    try {
      reg.register(makeTool("skill__git_helper"), makeHandler("v2"));
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-6004");
    }
  });
});
