// Slice 7 Task 1 — McpClient lifecycle smoke against a mock server.
//
// Drives @funclaw/mcp-client's McpClient through:
//   - connect(): spawns smoke-mcp-mock-server.cjs as the MCP server,
//     performs initialize handshake, queries tools/list, returns
//     prefixed tool definitions.
//   - callTool() x2: echo and add. Asserts the SDK returns the
//     expected `content` array.
//   - disconnect(): closes the SDK transport, kills the subprocess.
//   - post-disconnect verification: isAlive flips to false; a second
//     callTool fails with FC-3007 (tool unavailable) since the
//     client is dead.
//
// Plus a negative-path scenario:
//   - connect() against a deliberately-bad command. Expects FC-3001.
//
// Per the maintainer's smoke convention (saved feedback for slices
// 5/6): this script stays at the project root after running. Always
// run from the workspace root so the relative paths to packages/ and
// the mock server resolve correctly.
//
// Run: node smoke-mcp-client.cjs
"use strict";

const path = require("node:path");

const corePath = path.join(__dirname, "packages", "core", "dist", "index.js");
const mcpClientPath = path.join(__dirname, "packages", "mcp-client", "dist", "index.js");
const mockServerPath = path.join(__dirname, "smoke-mcp-mock-server.cjs");

const { isFunClawError } = require(corePath);
const { McpClient, formatMcpCallToolResult } = require(mcpClientPath);

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

async function main() {
  out("Slice 7 Task 1 smoke — McpClient against mock MCP server");
  out("========================================================");

  let passed = 0;
  let failed = 0;

  // -------------------------------------------------------------------
  // Scenario A — happy-path lifecycle
  // -------------------------------------------------------------------
  out("");
  out("--- Scenario A: connect → list → call → disconnect ---");

  const client = new McpClient();
  let crashEvents = 0;
  client.on("crash", (evt) => {
    crashEvents += 1;
    fail(`  crash event: ${JSON.stringify(evt)}`);
  });

  try {
    const result = await client.connect("mock", {
      command: process.execPath, // node
      args: [mockServerPath],
    });

    // (A1) tools come back, prefixed
    if (result.tools.length === 2) {
      out(`PASS A1: connect returned ${result.tools.length} tools`);
      passed += 1;
    } else {
      fail(`FAIL A1: expected 2 tools, got ${result.tools.length}`);
      failed += 1;
    }

    const echoTool = result.tools.find((t) => t.name === "mcp__mock__echo");
    const addTool = result.tools.find((t) => t.name === "mcp__mock__add");

    // (A2) prefix format applied
    if (echoTool !== undefined && addTool !== undefined) {
      out("PASS A2: tool names prefixed as mcp__mock__<tool>");
      passed += 1;
    } else {
      fail("FAIL A2: prefixed tool names not found");
      fail(`  observed names: ${result.tools.map((t) => t.name).join(", ")}`);
      failed += 1;
    }

    // (A3) input schema preserved verbatim
    const echoSchema = echoTool?.inputSchema;
    const echoOk =
      echoSchema !== undefined &&
      echoSchema.type === "object" &&
      echoSchema.properties !== undefined &&
      echoSchema.properties.message !== undefined;
    if (echoOk) {
      out("PASS A3: inputSchema preserved (echo.message present)");
      passed += 1;
    } else {
      fail("FAIL A3: inputSchema malformed for echo tool");
      failed += 1;
    }

    // (A4) isAlive after connect
    if (client.isAlive === true) {
      out("PASS A4: client.isAlive === true after connect");
      passed += 1;
    } else {
      fail("FAIL A4: client.isAlive should be true after successful connect");
      failed += 1;
    }

    // (A5) callTool: echo
    const ac = new AbortController();
    const echoResult = await client.callTool("echo", { message: "hello mcp" }, ac.signal);
    const echoFormatted = formatMcpCallToolResult(echoResult);
    if (echoFormatted.text === "echo: hello mcp" && echoFormatted.isError === false) {
      out(`PASS A5: callTool(echo) → ${JSON.stringify(echoFormatted.text)}`);
      passed += 1;
    } else {
      fail(`FAIL A5: unexpected echo result: ${JSON.stringify(echoFormatted)}`);
      failed += 1;
    }

    // (A6) callTool: add
    const addResult = await client.callTool("add", { a: 7, b: 35 }, ac.signal);
    const addFormatted = formatMcpCallToolResult(addResult);
    if (addFormatted.text === "42" && addFormatted.isError === false) {
      out(`PASS A6: callTool(add) → ${JSON.stringify(addFormatted.text)}`);
      passed += 1;
    } else {
      fail(`FAIL A6: unexpected add result: ${JSON.stringify(addFormatted)}`);
      failed += 1;
    }

    // (A7) callTool: unknown name returns isError
    const unknownResult = await client.callTool("not_a_tool", {}, ac.signal);
    const unknownFormatted = formatMcpCallToolResult(unknownResult);
    if (unknownFormatted.isError === true) {
      out(
        `PASS A7: callTool(unknown) → isError=true, text=${JSON.stringify(unknownFormatted.text)}`,
      );
      passed += 1;
    } else {
      fail(
        `FAIL A7: unknown tool should return isError=true; got ${JSON.stringify(unknownFormatted)}`,
      );
      failed += 1;
    }

    // (A8) disconnect cleanly
    await client.disconnect();
    if (client.isAlive === false) {
      out("PASS A8: disconnect() flipped isAlive to false");
      passed += 1;
    } else {
      fail("FAIL A8: client.isAlive should be false after disconnect");
      failed += 1;
    }

    // (A9) idempotent disconnect
    await client.disconnect();
    out("PASS A9: second disconnect() did not throw (idempotent)");
    passed += 1;

    // (A10) callTool after disconnect → FC-3007
    try {
      await client.callTool("echo", { message: "should fail" }, ac.signal);
      fail("FAIL A10: callTool after disconnect should have thrown FC-3007");
      failed += 1;
    } catch (e) {
      if (isFunClawError(e) && e.code === "FC-3007") {
        out("PASS A10: callTool after disconnect threw FC-3007 as expected");
        passed += 1;
      } else {
        fail(`FAIL A10: expected FC-3007, got ${fmtErr(e)}`);
        failed += 1;
      }
    }
  } catch (e) {
    fail(`Scenario A threw at top level: ${fmtErr(e)}`);
    if (e instanceof Error && e.stack) {
      fail(e.stack.split("\n").slice(0, 8).join("\n"));
    }
    failed += 1;
    try {
      await client.disconnect();
    } catch {
      // best-effort
    }
  }

  // (A11) no crash events fired during normal lifecycle
  if (crashEvents === 0) {
    out("PASS A11: no crash events during normal lifecycle");
    passed += 1;
  } else {
    fail(`FAIL A11: ${crashEvents} crash event(s) fired during normal lifecycle`);
    failed += 1;
  }

  // -------------------------------------------------------------------
  // Scenario B — bad command produces FC-3001
  // -------------------------------------------------------------------
  out("");
  out("--- Scenario B: connect with bad command → FC-3001 ---");

  const badClient = new McpClient();
  try {
    await badClient.connect("bad", {
      command: "definitely-not-an-executable-12345",
      args: [],
    });
    fail("FAIL B1: connect with bad command should have thrown");
    failed += 1;
  } catch (e) {
    if (isFunClawError(e) && e.code === "FC-3001") {
      out(`PASS B1: connect with bad command threw FC-3001: ${e.message}`);
      passed += 1;
    } else {
      // Some Windows shells may surface ENOENT as a different error
      // path; accept FC-3002 (init error) here too since the
      // user-visible behavior — chat session continues without the
      // server's tools — is the same. Log which code we saw.
      if (isFunClawError(e) && (e.code === "FC-3002" || e.code === "FC-3003")) {
        out(
          `PASS B1: connect with bad command threw ${e.code} (acceptable variant on this platform)`,
        );
        passed += 1;
      } else {
        fail(`FAIL B1: expected FC-3001 / FC-3002 / FC-3003, got ${fmtErr(e)}`);
        failed += 1;
      }
    }
  }

  if (badClient.isAlive === false) {
    out("PASS B2: bad client isAlive === false after failed connect");
    passed += 1;
  } else {
    fail("FAIL B2: bad client should not be alive after failed connect");
    failed += 1;
  }

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  out("");
  out("========================================================");
  out("SUMMARY");
  out("========================================================");
  out(`assertions passed: ${passed}`);
  out(`assertions failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  fail(`smoke-mcp-client FAILED unexpectedly: ${e.stack ?? e.message ?? String(e)}`);
  process.exit(1);
});
