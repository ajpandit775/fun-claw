// Slice 7 Task 1 — hand-rolled mock MCP server.
//
// Speaks just enough of the Model Context Protocol over stdio to let
// `@funclaw/mcp-client`'s McpClient connect, list tools, and call
// them. Used by `smoke-mcp-client.cjs` to verify the wrapper's
// lifecycle without depending on a published MCP server (which would
// drag in npm install latency on first run).
//
// Protocol coverage:
//   - `initialize` — responds with our own protocolVersion echo,
//     no advertised capabilities, fake serverInfo.
//   - `notifications/initialized` — silently accepted.
//   - `tools/list` — returns two hardcoded tools: `echo` and `add`.
//   - `tools/call` — handles `echo` and `add`, returns isError for
//     anything else.
//   - Anything else — returns a JSON-RPC -32601 method-not-found.
//
// Per CLAUDE.md "Never `console.log` in library code"; this is a
// standalone smoke fixture, not library code, so console.error for
// debug output is fine. We never write to stdout other than via the
// JSON-RPC writer (stdout IS the protocol channel).
//
// Per the maintainer's smoke convention: this script stays at the
// project root after running so it can be re-run on demand.
"use strict";

const readline = require("node:readline");

const SERVER_INFO = { name: "funclaw-smoke-mock", version: "1.0.0" };

function send(message) {
  // MCP stdio framing is newline-delimited JSON.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back as text. Used to verify round-trip behavior in smokes.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo." },
      },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First addend." },
        b: { type: "number", description: "Second addend." },
      },
      required: ["a", "b"],
    },
  },
];

function handleToolsCall(id, params) {
  const name = params && typeof params === "object" ? params.name : undefined;
  const args =
    params && typeof params === "object" && params.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {};

  if (name === "echo") {
    const text = `echo: ${String(args.message ?? "")}`;
    respond(id, { content: [{ type: "text", text }] });
    return;
  }
  if (name === "add") {
    const a = Number(args.a);
    const b = Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      respond(id, {
        content: [{ type: "text", text: "add requires numeric a and b" }],
        isError: true,
      });
      return;
    }
    respond(id, { content: [{ type: "text", text: String(a + b) }] });
    return;
  }
  respond(id, {
    content: [{ type: "text", text: `unknown tool: ${String(name)}` }],
    isError: true,
  });
}

function handleMessage(msg) {
  // Notifications have no `id`; we accept and don't respond.
  if (msg.method !== undefined && msg.id === undefined) {
    // notifications/initialized, etc. Silently accept.
    return;
  }

  const id = msg.id;
  const method = msg.method;

  switch (method) {
    case "initialize": {
      // Echo whatever protocolVersion the client sent, with no
      // advertised capabilities. This is the simplest valid response.
      const protocolVersion =
        msg.params &&
        typeof msg.params === "object" &&
        typeof msg.params.protocolVersion === "string"
          ? msg.params.protocolVersion
          : "2025-03-26";
      respond(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "tools/list":
      respond(id, { tools: TOOLS });
      return;
    case "tools/call":
      handleToolsCall(id, msg.params);
      return;
    case "ping":
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `method not found: ${String(method)}`);
      return;
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    process.stderr.write(`mock server: failed to parse JSON-RPC line: ${e.message}\n`);
    return;
  }
  try {
    handleMessage(parsed);
  } catch (e) {
    process.stderr.write(`mock server: handler threw: ${e.message ?? String(e)}\n`);
  }
});

rl.on("close", () => {
  // Parent closed our stdin — clean exit.
  process.exit(0);
});
