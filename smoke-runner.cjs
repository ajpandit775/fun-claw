// Slice 5 runner smoke — real Docker daemon.
//
// Closes the verification gap recorded in CLAUDE.md feedback: drives
// `DockerRunner` through ensureImage → createSession → six exec
// scenarios → destroySession → listOrphanedSessions, then verifies via
// `docker ps -a` that the container is gone.
//
// Tests:
//   T1 — `echo hello`: stdout demux + clean exit 0
//   T2 — `id -u`: confirms the SANDBOX_USER_STRING ("10001:10001") is
//        actually applied — i.e., execs run as uid 10001 inside the
//        container, not as root
//   T3 — `sh -c "cd /tmp && touch markerfile && ls /tmp"`: writable
//        tmpfs as the sandbox user, plus state setup for T4
//   T4 — `ls /tmp` as a separate exec: state shares across execs in the
//        same session (markerfile still there)
//   T5 — `sh -c "exit 7"`: non-zero exit code propagates as
//        `{ type: "exit", code: 7 }`
//   T6 — `sh -c "echo to-stdout && echo to-stderr 1>&2"`: stdout and
//        stderr streams demux into separate event types
// Plus:
//   - destroySession idempotency (second call no-ops)
//   - host `docker ps -a` finds zero containers with our session label
//   - listOrphanedSessions([]) does not include our just-destroyed UUID
//
// Per the maintainer's instruction: this script stays at the project
// root after running so it can be re-run on demand. STACK forbids
// `child_process.exec(string)`, so the host docker check uses
// `spawnSync` with argv form.
//
// Run: node smoke-runner.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const runnerPath = path.join(__dirname, "packages", "docker-runner", "dist", "index.js");
const { DockerRunner } = require(runnerPath);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
}

function fmtErr(e) {
  const code = e && typeof e === "object" ? e.code : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  return `${code !== undefined ? `[${code}] ` : ""}${msg}`;
}

async function collectExec(handle, argv, opts) {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for await (const event of handle.exec(argv, opts ?? {})) {
    if (event.type === "stdout") {
      stdout += event.data.toString("utf8");
    } else if (event.type === "stderr") {
      stderr += event.data.toString("utf8");
    } else if (event.type === "exit") {
      exitCode = event.code;
    }
  }
  return { stdout, stderr, exitCode };
}

const TESTS = [
  {
    label: "T1 echo hello",
    argv: ["echo", "hello"],
    expect: (r) => r.exitCode === 0 && r.stdout.trim() === "hello",
    summary: (r) => `stdout=${JSON.stringify(r.stdout.trim())} exit=${r.exitCode}`,
  },
  {
    label: "T2 id -u (uid 10001 enforced)",
    argv: ["id", "-u"],
    expect: (r) => r.exitCode === 0 && r.stdout.trim() === "10001",
    summary: (r) => `stdout=${JSON.stringify(r.stdout.trim())} exit=${r.exitCode}`,
  },
  {
    label: "T3 sh -c 'cd /tmp && touch markerfile && ls /tmp'",
    argv: ["sh", "-c", "cd /tmp && touch markerfile && ls /tmp"],
    expect: (r) => r.exitCode === 0 && r.stdout.includes("markerfile"),
    summary: (r) => `stdout=${JSON.stringify(r.stdout.trim())} exit=${r.exitCode}`,
  },
  {
    label: "T4 ls /tmp (state shares across execs)",
    argv: ["ls", "/tmp"],
    expect: (r) => r.exitCode === 0 && r.stdout.includes("markerfile"),
    summary: (r) => `stdout=${JSON.stringify(r.stdout.trim())} exit=${r.exitCode}`,
  },
  {
    label: "T5 sh -c 'exit 7' (non-zero exit propagation)",
    argv: ["sh", "-c", "exit 7"],
    expect: (r) => r.exitCode === 7,
    summary: (r) => `exit=${r.exitCode}`,
  },
  {
    label: "T6 stdout/stderr demux",
    argv: ["sh", "-c", "echo to-stdout && echo to-stderr 1>&2"],
    expect: (r) =>
      r.exitCode === 0 && r.stdout.trim() === "to-stdout" && r.stderr.trim() === "to-stderr",
    summary: (r) =>
      `stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim())} exit=${r.exitCode}`,
  },
];

async function main() {
  out("Slice 5 runner smoke — real Docker daemon");
  out("=========================================");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-runner-smoke-"));
  out(`workingDir: ${tmpDir}`);

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
    let pullEvents = 0;
    await runner.ensureImage({
      onProgress: (status) => {
        pullEvents += 1;
        // Throttle progress lines so the smoke output stays readable.
        if (pullEvents <= 4 || pullEvents % 10 === 0) {
          out(`  ${status}`);
        }
      },
    });
    out(`ensureImage ok (${pullEvents} progress events)`);
    passed += 1;

    sessionUuid = randomUUID();
    out("");
    out(`--- createSession(${sessionUuid}) ---`);
    handle = await runner.createSession(sessionUuid);
    out(`session created; container id ${handle.containerId.slice(0, 12)}`);
    passed += 1;

    for (const test of TESTS) {
      out("");
      out(`--- ${test.label} ---`);
      try {
        const result = await collectExec(handle, test.argv);
        const ok = test.expect(result);
        out(`  ${test.summary(result)}`);
        if (result.stderr.length > 0 && result.stderr.trim() !== "to-stderr") {
          out(`  stderr=${JSON.stringify(result.stderr.trim())}`);
        }
        out(`  ${ok ? "PASS" : "FAIL"}`);
        if (ok) {
          passed += 1;
        } else {
          failed += 1;
        }
      } catch (e) {
        fail(`  threw: ${fmtErr(e)}`);
        failed += 1;
      }
    }

    out("");
    out("--- destroySession ---");
    await runner.destroySession(handle);
    out("destroySession ok");

    out("");
    out("--- destroySession idempotency (second call) ---");
    await runner.destroySession(handle);
    out("destroySession second call ok");
    passed += 1;

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
        out("PASS");
        passed += 1;
      } else {
        fail(`container still present: ${remaining}`);
        failed += 1;
      }
    }

    out("");
    out("--- listOrphanedSessions([]) ---");
    const orphans = await runner.listOrphanedSessions([]);
    const ourSession = orphans.find((o) => o.sessionId === sessionUuid);
    if (ourSession === undefined) {
      out(`no orphan with our UUID (total orphans: ${orphans.length}, none match)`);
      out("PASS");
      passed += 1;
    } else {
      fail(`our session UUID still listed as orphan: ${JSON.stringify(ourSession)}`);
      failed += 1;
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
  out("=========================================");
  out("SUMMARY");
  out("=========================================");
  out(`assertions passed: ${passed}`);
  out(`assertions failed: ${failed}`);
  out("");
  out(
    "(coverage: ensureImage, createSession, T1-T6 execs, destroy + idempotency, host docker ps verification, listOrphanedSessions)",
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  fail(`smoke-runner FAILED unexpectedly: ${e.stack ?? e.message ?? String(e)}`);
  process.exit(1);
});
