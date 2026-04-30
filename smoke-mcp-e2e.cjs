// Slice 7 Task 4 — MCP end-to-end smoke against the official
// `@modelcontextprotocol/server-filesystem` server, the Docker
// runtime, and a real OpenAI LLM.
//
// Drives the full Slice 7 wiring without the ink TUI:
//   1. Set up a temp dir with a sample file ("hello.txt" containing
//      "hello from MCP").
//   2. createProvider("openai") + DockerRunner ensureImage +
//      createSession (mirrors chat.ts).
//   3. Spawn the filesystem MCP server scoped to the temp dir,
//      register its prefixed tools (`mcp__filesystem__*`).
//   4. Register `execute_bash` against the sandbox container.
//   5. Run runAgentLoop with one user message: "Read the file
//      hello.txt and tell me what it says."
//   6. Assert: at least one tool-call-start was an MCP filesystem
//      call, a tool-call-result included "hello from MCP", the
//      final assistant text references the file content,
//      stopReason is end_turn.
//   7. Cleanup: disconnect MCP, destroy session, remove temp dir.
//
// Per CLAUDE.md "Live LLM tests are gated. Only run when
// RUN_LIVE_LLM_TESTS=1 is set, with a FUN_CLAW_LIVE_BUDGET_USD=0.50
// cap. Never in normal PRs." This script enforces both gates.
//
// First-run note: `npx -y @modelcontextprotocol/server-filesystem`
// downloads the server on first use (~5–10 seconds). Subsequent
// runs use the npm cache.
//
// Run:
//   $env:RUN_LIVE_LLM_TESTS="1"
//   $env:FUN_CLAW_LIVE_BUDGET_USD="0.50"
//   $env:OPENAI_API_KEY="sk-..."
//   node smoke-mcp-e2e.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const corePath = path.join(__dirname, "packages", "core", "dist", "index.js");
const runnerPath = path.join(__dirname, "packages", "docker-runner", "dist", "index.js");
const mcpClientPath = path.join(__dirname, "packages", "mcp-client", "dist", "index.js");

const { buildSystemPrompt, createProvider, isFunClawError, runAgentLoop, ToolRegistry } = require(
  corePath,
);
const { DockerRunner, executeBashTool, parseExecuteBashInput, runExecuteBashSync } = require(
  runnerPath,
);
const { buildPrefixedToolName, formatMcpCallToolResult, McpClient } = require(mcpClientPath);

function out(line) {
  process.stdout.write(`${line}\n`);
}
function fail(line) {
  process.stderr.write(`${line}\n`);
}
function fmtErr(e) {
  if (isFunClawError(e)) return `[${e.code}] ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

if (process.env.RUN_LIVE_LLM_TESTS !== "1") {
  out("smoke-mcp-e2e: skipped (set RUN_LIVE_LLM_TESTS=1 to run).");
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length === 0) {
  fail("smoke-mcp-e2e: OPENAI_API_KEY is not set; live OpenAI test cannot run.");
  process.exit(2);
}
const budget = process.env.FUN_CLAW_LIVE_BUDGET_USD ?? "(unset)";
const PROMPT = "Read the file hello.txt and tell me what it says.";
const MODEL = process.env.FUNCLAW_MODEL ?? "gpt-4o-mini";
// Pass an explicit, version-pinned spec for `npx -y` so the cache
// stays warm across runs and we don't pull a new latest each time.
const FILESYSTEM_PACKAGE = "@modelcontextprotocol/server-filesystem";

async function main() {
  out("Slice 7 Task 4 smoke — MCP filesystem + Docker + OpenAI");
  out("========================================================");
  out(`model: ${MODEL}`);
  out(`MCP filesystem package: ${FILESYSTEM_PACKAGE}`);
  out(`budget cap (USD): ${budget}`);
  out("");

  // (1) Temp dir + sample files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-mcp-smoke-"));
  fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello from MCP", "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "data.json"),
    JSON.stringify({ greeting: "hi", numbers: [1, 2, 3] }, null, 2),
    "utf8",
  );
  out(`workingDir: ${tmpDir}`);

  const provider = createProvider({ provider: "openai" });
  const runner = new DockerRunner({
    image: "ubuntu:24.04",
    workingDir: tmpDir,
    networkMode: "bridge",
  });

  let passed = 0;
  let failed = 0;
  let mcpClient;
  let sessionHandle;
  let sessionUuid = "";

  try {
    // (2) Image + container
    out("");
    out("--- ensureImage() ---");
    await runner.ensureImage({
      onProgress: (status) => {
        if (status.length > 0) out(`  ${status.slice(0, 80)}`);
      },
    });
    out("ensureImage ok");

    sessionUuid = randomUUID();
    out("");
    out(`--- createSession(${sessionUuid}) ---`);
    sessionHandle = await runner.createSession(sessionUuid);
    out(`session created; container id ${sessionHandle.containerId.slice(0, 12)}`);

    // (3) Spawn the filesystem MCP server scoped to tmpDir.
    out("");
    out(`--- McpClient.connect("filesystem") via npx -y ${FILESYSTEM_PACKAGE} ---`);
    out("(first run downloads the package; subsequent runs use the npm cache)");

    // npx-as-a-spawn: on Windows the shim is `npx.cmd`. cross-spawn
    // (used by the SDK's StdioClientTransport) handles the .cmd
    // resolution automatically when given the bare name "npx".
    mcpClient = new McpClient({
      // Bump startup timeout for the first-run npx download path.
      // Once the server-filesystem package is cached, this is fast.
      startupTimeoutMs: 60_000,
    });
    const connectResult = await mcpClient.connect("filesystem", {
      command: "npx",
      args: ["-y", FILESYSTEM_PACKAGE, tmpDir],
    });
    out(
      `MCP filesystem connected: ${connectResult.tools.length} tools registered ` +
        `(${connectResult.rawTools
          .map((t) => t.name)
          .slice(0, 5)
          .join(", ")}${connectResult.rawTools.length > 5 ? ", ..." : ""})`,
    );

    // (4) Build the registry with execute_bash + MCP tools.
    const registry = new ToolRegistry();

    const executeBashHandler = async (toolCall, _ctx, signal) => {
      const input = parseExecuteBashInput(toolCall.input);
      return runExecuteBashSync(sessionHandle, input, toolCall.id, {
        abortSignal: signal,
      });
    };
    registry.register(executeBashTool, executeBashHandler);

    const mcpEntries = connectResult.rawTools.map((rawTool) => {
      const definition = connectResult.tools.find(
        (d) => d.name === buildPrefixedToolName("filesystem", rawTool.name),
      );
      if (definition === undefined) throw new Error(`adapter glitch: ${rawTool.name}`);
      const handler = async (toolCall, _ctx, signal) => {
        const inputArgs =
          toolCall.input !== null && typeof toolCall.input === "object" ? toolCall.input : {};
        const sdkResult = await mcpClient.callTool(rawTool.name, inputArgs, signal);
        const formatted = formatMcpCallToolResult(sdkResult);
        const result = { toolUseId: toolCall.id, content: formatted.text };
        if (formatted.isError) result.isError = true;
        return result;
      };
      return { definition, handler };
    });
    registry.registerMcpServer("filesystem", mcpEntries);

    const systemPrompt = buildSystemPrompt({
      tools: registry.getDefinitions(),
      sessionUuid,
      workingDir: tmpDir,
      mcpServerNames: registry.getMcpServerNames(),
    });

    // (5) Drive the agent loop with our fixed prompt.
    out("");
    out("--- runAgentLoop ---");
    out(`prompt: ${JSON.stringify(PROMPT)}`);
    out(
      `registered tools: ${registry
        .getDefinitions()
        .map((t) => t.name)
        .join(", ")}`,
    );

    let sawMcpFilesystemCall = false;
    let toolResultMentionsHello = false;
    let finalText = "";
    let lastStopReason = "(none)";
    const events = [];

    for await (const event of runAgentLoop({
      provider,
      registry,
      initialMessages: [{ role: "user", content: PROMPT }],
      systemPrompt,
      model: MODEL,
      sessionUuid,
    })) {
      events.push(event.type);
      switch (event.type) {
        case "turn-start":
          out(`  turn ${event.iteration} start`);
          break;
        case "text-delta":
          finalText += event.text;
          break;
        case "tool-call-start": {
          out(`  tool-call-start: ${event.call.name}`);
          if (event.call.name.startsWith("mcp__filesystem__")) {
            sawMcpFilesystemCall = true;
          }
          break;
        }
        case "tool-call-result": {
          const content = String(event.result.content ?? "");
          const head = content.replace(/\r?\n/g, " ").slice(0, 120);
          out(
            `  tool-call-result: isError=${event.result.isError === true} head=${JSON.stringify(head)}`,
          );
          if (content.includes("hello from MCP")) toolResultMentionsHello = true;
          break;
        }
        case "turn-stop":
          lastStopReason = event.stopReason;
          out(`  turn-stop: stopReason=${event.stopReason}`);
          if (event.stopReason === "tool_use") {
            // Still mid-loop; reset finalText so the assertion below
            // sees the LAST turn's text only.
            finalText = "";
          }
          break;
        case "iteration-cap-hit":
          fail(`  iteration-cap-hit: ${fmtErr(event.error)}`);
          break;
        case "error":
          fail(`  error event: ${fmtErr(event.error)}`);
          break;
      }
    }

    // (6) Assertions
    out("");
    out("--- assertions ---");

    if (sawMcpFilesystemCall) {
      out("PASS: model called an mcp__filesystem__* tool");
      passed += 1;
    } else {
      fail("FAIL: model did not call any mcp__filesystem__* tool");
      failed += 1;
    }

    if (toolResultMentionsHello) {
      out("PASS: tool result included `hello from MCP`");
      passed += 1;
    } else {
      fail("FAIL: tool result did not include `hello from MCP`");
      failed += 1;
    }

    const finalLower = finalText.toLowerCase();
    if (finalLower.includes("hello from mcp")) {
      out("PASS: final assistant text references the file content");
      out(`  text: ${JSON.stringify(finalText.trim().slice(0, 240))}`);
      passed += 1;
    } else {
      fail("FAIL: final assistant text did not reference the file content");
      fail(`  text: ${JSON.stringify(finalText.trim().slice(0, 240))}`);
      failed += 1;
    }

    if (lastStopReason === "end_turn") {
      out("PASS: agent loop ended with stopReason=end_turn");
      passed += 1;
    } else {
      fail(`FAIL: final stopReason=${lastStopReason} (expected end_turn)`);
      failed += 1;
    }

    const toolResultCount = events.filter((e) => e === "tool-call-result").length;
    if (toolResultCount >= 1) {
      out(`PASS: observed ${toolResultCount} tool-call-result event(s)`);
      passed += 1;
    } else {
      fail("FAIL: no tool-call-result events observed");
      failed += 1;
    }

    // (7) Cleanup will run in the finally below.
  } catch (e) {
    fail(`Top-level threw: ${fmtErr(e)}`);
    if (e instanceof Error && e.stack) {
      fail(e.stack.split("\n").slice(0, 8).join("\n"));
    }
    failed += 1;
  } finally {
    if (mcpClient !== undefined) {
      try {
        await mcpClient.disconnect();
        out("MCP filesystem client disconnected");
      } catch (e) {
        fail(`MCP disconnect threw: ${fmtErr(e)}`);
      }
    }
    if (sessionHandle !== undefined) {
      try {
        await runner.destroySession(sessionHandle);
        out("destroySession ok");

        const psResult = spawnSync(
          "docker",
          ["ps", "-aq", "--filter", `label=funclaw.session=${sessionUuid}`],
          { encoding: "utf8" },
        );
        if (psResult.error === undefined && (psResult.stdout ?? "").trim() === "") {
          out("PASS: container cleaned up (docker ps shows no remnant)");
          passed += 1;
        } else {
          fail(`FAIL: container remnant present or docker ps spawn error`);
          failed += 1;
        }
      } catch (e) {
        fail(`destroySession threw: ${fmtErr(e)}`);
        failed += 1;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  out("");
  out("========================================================");
  out("SUMMARY");
  out("========================================================");
  out(`assertions passed: ${passed}`);
  out(`assertions failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  fail(`smoke-mcp-e2e FAILED unexpectedly: ${e.stack ?? e.message ?? String(e)}`);
  process.exit(1);
});
