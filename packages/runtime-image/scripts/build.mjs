#!/usr/bin/env node
// Build the Fun Claw runtime sandbox image.
//
// Usage:
//   node scripts/build.mjs                     -> tags ghcr.io/ajpandit775/fun-claw-runtime:<version> + :latest
//   node scripts/build.mjs --tag local         -> single local tag fun-claw-runtime:local
//   node scripts/build.mjs --registry <repo>   -> override the registry/repo prefix
//   node scripts/build.mjs --platform <plat>   -> override the platform (default: docker buildx default)
//
// Reads the version from this package's own package.json. Captures
// the current git short-sha for the OCI revision label, and an
// ISO 8601 build timestamp. Both are passed as `--build-arg` to
// docker build so the labels are self-describing on the registry.
//
// Cross-platform: pure Node.js + child_process.spawnSync. No bash
// dependency. Runs identically on Linux / macOS / Windows.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
const repoRoot = resolve(packageDir, "..", "..");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith("--") || value === undefined) {
    console.error(`build.mjs: malformed flag near ${key}`);
    process.exit(2);
  }
  flags.set(key.slice(2), value);
}

const tagOverride = flags.get("tag");
const registryOverride = flags.get("registry");
const platformOverride = flags.get("platform");

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const pkgJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
const version = pkgJson.version;
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`build.mjs: package.json version "${version}" is not semver`);
  process.exit(2);
}

const revision = (() => {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "unknown";
  }
  return r.stdout.trim();
})();

const buildDate = new Date().toISOString();

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const tags = [];
if (tagOverride) {
  tags.push(`fun-claw-runtime:${tagOverride}`);
} else {
  const registry = registryOverride ?? "ghcr.io/ajpandit775/fun-claw-runtime";
  tags.push(`${registry}:${version}`);
  tags.push(`${registry}:latest`);
}

// ---------------------------------------------------------------------------
// docker build
// ---------------------------------------------------------------------------

const dockerArgs = ["build"];
for (const tag of tags) {
  dockerArgs.push("-t", tag);
}
if (platformOverride) {
  dockerArgs.push("--platform", platformOverride);
}
dockerArgs.push("--build-arg", `VERSION=${version}`);
dockerArgs.push("--build-arg", `REVISION=${revision}`);
dockerArgs.push("--build-arg", `BUILD_DATE=${buildDate}`);
dockerArgs.push(packageDir);

console.log(`build.mjs: docker ${dockerArgs.join(" ")}`);
console.log(`build.mjs: version=${version} revision=${revision} buildDate=${buildDate}`);

const r = spawnSync("docker", dockerArgs, {
  stdio: "inherit",
  shell: false,
});

if (r.status !== 0) {
  console.error(`build.mjs: docker build failed with exit ${r.status}`);
  process.exit(r.status ?? 1);
}

console.log(`\nbuild.mjs: built ${tags.length === 1 ? "tag" : "tags"}:`);
for (const tag of tags) console.log(`  ${tag}`);
