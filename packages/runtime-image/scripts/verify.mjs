#!/usr/bin/env node
// Verify a built Fun Claw runtime sandbox image meets the contract.
//
// Usage:
//   node scripts/verify.mjs [--tag <image-tag>]
//
// Defaults to `fun-claw-runtime:local` (what `pnpm run build:local`
// produces). Override with --tag to verify a registry-tagged image.
//
// Checks:
//   1. uid 10001 — the container's default user is the agent, not root.
//   2. /workspace — pre-created, owned by uid 10001, writable.
//   3. /tmp — pre-created, mode 1777 (writable + sticky).
//   4. node --version — Node 22 LTS available on PATH.
//   5. pnpm --version — Corepack-activated pnpm available.
//   6. git, curl, jq, python3 — common toolchain present.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
let tag = "fun-claw-runtime:local";
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--tag" && args[i + 1]) tag = args[i + 1];
}

let failures = 0;
let passes = 0;

function runIn(image, cmd) {
  // Always pass --rm and override entrypoint to /bin/sh so the
  // entrypoint script's /workspace and /tmp checks don't trip on
  // a fresh container with no bind mount (the entrypoint expects a
  // writable /workspace; the image's pre-created one IS writable
  // for uid 10001, so this is fine, but using /bin/sh gives us
  // more predictable command execution for verification).
  return spawnSync("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-c", cmd], {
    encoding: "utf8",
  });
}

function check(name, cmd, validate) {
  process.stdout.write(`  ${name} ... `);
  const r = runIn(tag, cmd);
  if (r.status !== 0) {
    console.log(`FAIL (exit ${r.status})`);
    if (r.stderr) console.log(`    stderr: ${r.stderr.trim()}`);
    failures++;
    return;
  }
  const out = (r.stdout ?? "").trim();
  const ok = validate(out);
  if (ok === true) {
    console.log(`OK (${out})`);
    passes++;
  } else {
    console.log(`FAIL: ${ok}`);
    console.log(`    output: ${out}`);
    failures++;
  }
}

console.log(`verify.mjs: checking image ${tag}\n`);

check("uid is 10001", "id -u", (out) => out === "10001" || `expected 10001, got ${out}`);
check("gid is 10001", "id -g", (out) => out === "10001" || `expected 10001, got ${out}`);
check(
  "/workspace writable",
  "touch /workspace/.verify-marker && rm /workspace/.verify-marker && echo ok",
  (out) => out === "ok" || `unexpected output: ${out}`,
);
check(
  "/tmp writable",
  "touch /tmp/.verify-marker && rm /tmp/.verify-marker && echo ok",
  (out) => out === "ok" || `unexpected output: ${out}`,
);
check(
  "/tmp has sticky bit (1777)",
  "stat -c '%a' /tmp",
  (out) => out === "1777" || `expected 1777, got ${out}`,
);
check(
  "node --version is v22.x",
  "node --version",
  (out) => /^v22\./.test(out) || `expected v22.x, got ${out}`,
);
check(
  "pnpm --version is reachable",
  "pnpm --version",
  (out) => /^\d+\.\d+\.\d+/.test(out) || `expected semver, got ${out}`,
);
check("git is on PATH", "command -v git", (out) => out.length > 0 || "git not found");
check("curl is on PATH", "command -v curl", (out) => out.length > 0 || "curl not found");
check("jq is on PATH", "command -v jq", (out) => out.length > 0 || "jq not found");
check(
  "python3 --version is 3.x",
  "python3 --version",
  (out) => /^Python 3\./.test(out) || `expected Python 3.x, got ${out}`,
);

console.log(`\nverify.mjs: ${passes} passed, ${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
