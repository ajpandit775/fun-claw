#!/usr/bin/env node
// Copy the repo-root README.md into packages/cli/README.md so the
// published `fun-claw` tarball ships the same README that GitHub
// shows. Runs as the `prepublishOnly` lifecycle script just before
// `npm publish` packs the tarball.
//
// `prepublishOnly` is a publish-time hook, NOT an install-time hook
// — install-time hooks (preinstall / install / postinstall) are
// banned per the package's security stance. The two are unrelated:
// install hooks run on every consumer machine when `npm install`
// resolves the package; publish hooks run only on the publisher's
// machine when they invoke `npm publish`.
//
// Cross-platform: pure Node fs APIs, no shell. Works identically on
// Linux, macOS, and Windows.

import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
const repoRoot = resolve(packageDir, "..", "..");

const source = resolve(repoRoot, "README.md");
const dest = resolve(packageDir, "README.md");

copyFileSync(source, dest);
console.log(`sync-readme: ${source} -> ${dest}`);
