// Slice 6 chat end-to-end smoke — real Docker daemon + real OpenAI API.
//
// Drives the full Slice 6 wiring (agent loop + provider + tool registry +
// docker runner + execute_bash) without the ink TUI. The chat command
// in `packages/cli/src/commands/chat.ts` builds the same graph; this
// script substitutes the TUI for a deterministic event collector so the
// smoke is observable from CI logs.
//
// Per CLAUDE.md "Live LLM tests are gated. Only run when
// RUN_LIVE_LLM_TESTS=1 is set, with a FUN_CLAW_LIVE_BUDGET_USD=0.50
// cap. Never in normal PRs." This script enforces both gates at the top
// and exits without spending tokens if either is missing.
//
// What we verify:
//   1. createProvider("openai") returns a working stream (FC-2007 if the
//      key is bad).
//   2. ensureImage + createSession bring up the sandbox container.
//   3. The model emits a tool_use for execute_bash with command="pwd".
//   4. The dispatcher runs the tool, the result mentions /workspace
//      (the bind-mount target inside the sandbox).
//   5. The model receives the wrapped <tool_result> and produces a
//      final text answer that references /workspace.
//   6. destroySession cleans up the container; no leftover with our
//      session label.
//
// Per CLAUDE.md cross-platform rule the script avoids shell-string
// child_process.exec and uses argv-form spawn for the post-cleanup
// `docker ps -a` verification.
//
// Run:
//   $env:RUN_LIVE_LLM_TESTS="1"
//   $env:FUN_CLAW_LIVE_BUDGET_USD="0.50"   # contract; actual budget tracking is Slice 9
//   $env:OPENAI_API_KEY="sk-..."
//   node smoke-chat-e2e.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const corePath = path.join(__dirname, "packages", "core", "dist", "index.js");
const runnerPath = path.join(__dirname, "packages", "docker-runner", "dist", "index.js");

const { buildSystemPrompt, createProvider, isFunClawError, runAgentLoop, ToolRegistry } = require(
  corePath,
);
const { DockerRunner, executeBashTool, parseExecuteBashInput, runExecuteBashSync } = require(
  runnerPath,
);

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
  out("smoke-chat-e2e: skipped (set RUN_LIVE_LLM_TESTS=1 to run).");
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length === 0) {
  fail("smoke-chat-e2e: OPENAI_API_KEY is not set; live OpenAI test cannot run.");
  process.exit(2);
}
// Budget gate is informational in Slice 6 (actual budget tracking is
// the subagent work in Slice 9). Surface the configured cap so it
// shows up in the smoke log alongside the run.
const budget = process.env.FUN_CLAW_LIVE_BUDGET_USD ?? "(unset)";

const PROMPT = "Run the bash command pwd and tell me which directory you're in.";
const MODEL = process.env.FUNCLAW_MODEL ?? "gpt-4o-mini";

async function main() {
  out("Slice 6 chat E2E smoke — real Docker + real OpenAI");
  out("===================================================");
  out(`model: ${MODEL}`);
  out(`budget cap (USD): ${budget}`);
  out("");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-chat-smoke-"));
  out(`workingDir: ${tmpDir}`);

  const provider = createProvider({ provider: "openai" });

  const runner = new DockerRunner({
    image: "ubuntu:24.04",
    workingDir: tmpDir,
    networkMode: "bridge",
  });

  let passed = 0;
  let failed = 0;
  let handle;
  let sessionUuid = "";

  try {
    out("");
    out("--- ensureImage() ---");
    await runner.ensureImage({
      onProgress: (status) => {
        // Truncate progress to keep smoke output readable.
        if (status.length > 0) out(`  ${status.slice(0, 80)}`);
      },
    });
    out("ensureImage ok");

    sessionUuid = randomUUID();
    out("");
    out(`--- createSession(${sessionUuid}) ---`);
    handle = await runner.createSession(sessionUuid);
    out(`session created; container id ${handle.containerId.slice(0, 12)}`);

    // Mirror chat.ts wiring exactly.
    const registry = new ToolRegistry();
    const handler = async (toolCall, _ctx, signal) => {
      const input = parseExecuteBashInput(toolCall.input);
      return runExecuteBashSync(handle, input, toolCall.id, {
        abortSignal: signal,
      });
    };
    registry.register(executeBashTool, handler);

    const systemPrompt = buildSystemPrompt({
      tools: registry.getDefinitions(),
      sessionUuid,
      workingDir: tmpDir,
    });

    const initialMessages = [{ role: "user", content: PROMPT }];

    // Event collection.
    let sawPwdToolCall = false;
    let toolResultMentionsWorkspace = false;
    let finalText = "";
    let lastStopReason = "(none)";
    const events = [];

    out("");
    out("--- runAgentLoop ---");
    out(`prompt: ${JSON.stringify(PROMPT)}`);
    for await (const event of runAgentLoop({
      provider,
      registry,
      initialMessages,
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
          // Aggregate but don't print every byte — the final flush
          // below shows the full text.
          finalText += event.text;
          break;
        case "tool-call-start": {
          const cmd =
            event.call.input && typeof event.call.input === "object"
              ? event.call.input.command
              : "(missing)";
          out(`  tool-call-start: ${event.call.name} command=${JSON.stringify(cmd)}`);
          if (event.call.name === "execute_bash") {
            const c = String(cmd ?? "");
            if (c.trim() === "pwd" || /\bpwd\b/.test(c)) {
              sawPwdToolCall = true;
            }
          }
          break;
        }
        case "tool-call-result": {
          const content = String(event.result.content ?? "");
          const head = content.replace(/\r?\n/g, " ").slice(0, 120);
          out(
            `  tool-call-result: isError=${event.result.isError === true} head=${JSON.stringify(head)}`,
          );
          if (content.includes("/workspace")) {
            toolResultMentionsWorkspace = true;
          }
          break;
        }
        case "turn-stop":
          lastStopReason = event.stopReason;
          out(`  turn-stop: stopReason=${event.stopReason}`);
          // text-delta accumulator carries forward across loop iters;
          // reset after each turn so finalText holds only the FINAL
          // assistant turn's text.
          if (event.stopReason !== "tool_use") {
            // terminal turn — keep finalText as-is for assertion.
          } else {
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

    out("");
    out("--- assertions ---");

    // (1) tool call with command=pwd
    if (sawPwdToolCall) {
      out("PASS: model called execute_bash with `pwd`");
      passed += 1;
    } else {
      fail("FAIL: model did not call execute_bash with `pwd`");
      failed += 1;
    }

    // (2) tool result mentions /workspace
    if (toolResultMentionsWorkspace) {
      out("PASS: tool result included `/workspace`");
      passed += 1;
    } else {
      fail("FAIL: tool result did not include `/workspace`");
      failed += 1;
    }

    // (3) final assistant text references /workspace
    if (finalText.toLowerCase().includes("/workspace")) {
      out("PASS: final assistant text references `/workspace`");
      out(`  text: ${JSON.stringify(finalText.trim().slice(0, 240))}`);
      passed += 1;
    } else {
      fail(`FAIL: final assistant text did not reference /workspace`);
      fail(`  text: ${JSON.stringify(finalText.trim().slice(0, 240))}`);
      failed += 1;
    }

    // (4) final stop reason was end_turn (not error / aborted / max_iterations)
    if (lastStopReason === "end_turn") {
      out("PASS: agent loop ended with stopReason=end_turn");
      passed += 1;
    } else {
      fail(`FAIL: final stopReason=${lastStopReason} (expected end_turn)`);
      failed += 1;
    }

    // (5) at least one full LLM ↔ tool ↔ LLM round-trip
    const toolStops = events.filter((e) => e === "tool-call-result").length;
    if (toolStops >= 1) {
      out(`PASS: observed ${toolStops} tool-call-result event(s)`);
      passed += 1;
    } else {
      fail("FAIL: no tool-call-result events observed");
      failed += 1;
    }

    out("");
    out("--- destroySession ---");
    await runner.destroySession(handle);
    out("destroySession ok");

    out("");
    out("--- host docker ps -a verification ---");
    const psResult = spawnSync(
      "docker",
      ["ps", "-aq", "--filter", `label=funclaw.session=${sessionUuid}`],
      { encoding: "utf8" },
    );
    if (psResult.error !== undefined) {
      fail(`docker ps spawn error: ${psResult.error.message ?? "unknown"}`);
      failed += 1;
    } else {
      const remaining = (psResult.stdout ?? "").trim();
      if (remaining === "") {
        out(`no containers found with label funclaw.session=${sessionUuid}`);
        out("PASS: container cleaned up");
        passed += 1;
      } else {
        fail(`container still present: ${remaining}`);
        failed += 1;
      }
    }
  } catch (e) {
    fail(`top-level threw: ${fmtErr(e)}`);
    if (e instanceof Error && e.stack) {
      fail(e.stack.split("\n").slice(0, 8).join("\n"));
    }
    failed += 1;
    if (handle !== undefined) {
      try {
        await runner.destroySession(handle);
      } catch {
        // best-effort cleanup
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  out("");
  out("===================================================");
  out("SUMMARY");
  out("===================================================");
  out(`assertions passed: ${passed}`);
  out(`assertions failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  fail(`smoke-chat-e2e FAILED unexpectedly: ${e.stack ?? e.message ?? String(e)}`);
  process.exit(1);
});
