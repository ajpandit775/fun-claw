#!/usr/bin/env node
// Wipe packages/cli/dist/ before tsup rebuilds it. Runs as the
// `prebuild` lifecycle script — npm/pnpm fire `prebuild` automatically
// just before `build`.
//
// Why this exists: a prior `pnpm exec tsc -b` run can populate
// dist/{commands,components}/{*.js,*.d.ts,...} (composite: true +
// declaration: true emit the full source tree into the cli package's
// outDir). When tsup runs next with `clean: true` on its first entry,
// it removes the FILES inside those subdirs but a known Windows-rimraf
// quirk leaves the empty PARENT directories standing — the dir handle
// isn't released cleanly when the dir's last file is cleared. The
// empty subdirs are benign for publish (npm pack skips empty dirs)
// but they accumulate over time and confuse `Get-ChildItem` checks.
//
// `fs.rmSync` with `recursive: true, force: true` is plain Node API,
// stable across Node 20 / 22 / future LTS, and doesn't depend on tsup
// internals (their hooks API can shift across major versions). Same
// pattern as packages/cli/scripts/sync-readme.mjs (the prepublishOnly
// script): tiny, single-purpose, discoverable from package.json.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
const distDir = resolve(packageDir, "dist");

rmSync(distDir, { recursive: true, force: true });
console.log(`clean-dist: removed ${distDir}`);
