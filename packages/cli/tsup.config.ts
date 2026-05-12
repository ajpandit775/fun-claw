import { defineConfig } from "tsup";
import { baseTsupOptions } from "../../tsup.config";

// Per-package tsup config for the published `fun-claw` package.
//
// Two entries with mixed output formats:
//
//   1. `src/index.ts` → `dist/index.js` (CJS, the bin entry)
//      Keeps STACK's "CommonJS output" rule for the bin so the Node
//      SEA build target stays viable.
//
//   2. `src/chat-runtime.tsx` → `dist/chat-runtime.mjs` (ESM)
//      Hosts the ink-based chat TUI runtime. ink 5.x and ink-text-input
//      are ESM-only with top-level await; bundling them into CJS is
//      impossible (rollup rejects TLA in CJS) and `require("ink")` from
//      CJS hits ERR_REQUIRE_ASYNC_MODULE. Bundling the TUI as ESM and
//      having the CJS bin `await import()` it at action time bridges
//      the two cleanly: ESM-to-ESM resolves TLA at module load, no
//      sync-require constraint applies.
//
// Both entries share `baseTsupOptions` (target node22, sourcemaps,
// clean, treeshake, etc.) and inherit the SDK externals.
//
// Bundling strategy for the published `fun-claw` npm package:
//
//   - The four internal `@funclaw/*` packages (core, docker-runner,
//     mcp-client, skills) are private:true monorepo members. They get
//     **bundled** into dist/ at build time so the published `fun-claw`
//     package is self-contained — consumers running `npm install -g
//     fun-claw` don't need to install the @funclaw/* packages
//     separately (they couldn't, since those packages aren't
//     published).
//   - All third-party runtime deps (anthropic-ai/sdk, openai, dockerode,
//     etc.) stay **external**. Listed in `dependencies` of
//     packages/cli/package.json with semver ranges so the consumer's
//     npm install resolves them normally.
//   - This mirrors how the popular CLI npm packages (e.g. wrangler,
//     vite) ship: workspace internals bundled, third-party deps
//     resolved via the consumer's package manager.
const cliExternals = [
  ...(baseTsupOptions.external ?? []),
  // LLM SDKs — pulled in directly by the doctor command's lightweight
  // provider pings (1-token non-streaming requests). They already
  // ride along via @funclaw/core's adapters; declaring them here as
  // bin-level externals keeps the bundle size predictable.
  "@anthropic-ai/sdk",
  "@clack/prompts",
  "@google/genai",
  // The MCP SDK is a transitive runtime dep via @funclaw/mcp-client
  // (which gets bundled). External so it loads via Node's require
  // resolution at runtime rather than being inlined.
  "@modelcontextprotocol/sdk",
  "commander",
  // Transitive deps of @funclaw/core that get pulled in when the core
  // bundle is inlined. Listed external so they install normally via
  // `npm install fun-claw`'s dependency resolution.
  "cosmiconfig",
  "dockerode",
  "env-paths",
  "execa",
  "openai",
  "p-limit",
  "pino",
  "pino-pretty",
  "smol-toml",
  // `yaml` is a transitive runtime dep via @funclaw/skills (the
  // SKILL.md frontmatter parser). External so it loads from
  // node_modules at runtime rather than being inlined here.
  "yaml",
  "zod",
];

export default defineConfig([
  // (1) CJS bin entry
  {
    ...baseTsupOptions,
    entry: ["src/index.ts"],
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    // The CLI is a consumer-end binary, not a library. STACK's
    // `dts: true` policy is "for downstream consumers" which the bin
    // doesn't have; skipping declaration emission keeps the build fast.
    dts: false,
    external: [
      ...cliExternals,
      // ink/react aren't reached from the bin entry directly — chat
      // command's action does the dynamic import. Mark them external
      // so esbuild doesn't try to follow imports it shouldn't be
      // bundling here.
      "ink",
      "ink-text-input",
      "react",
      "react-devtools-core",
    ],
  },
  // (2) ESM chat-runtime entry
  {
    ...baseTsupOptions,
    entry: ["src/chat-runtime.tsx"],
    format: ["esm"],
    // chat-runtime.mjs is dynamic-imported from the bin; no consumers
    // beyond that, so dts is unnecessary.
    dts: false,
    // CJS dist also gets cleaned by the (1) entry's clean. The (2)
    // entry runs after; setting clean: false here prevents wiping the
    // bin output.
    clean: false,
    // createRequire banner — repairs esbuild's `__require2` shim in the
    // ESM bundle.
    //
    // Background (v0.1.0/v0.1.1 "Dynamic require of X" incidents,
    // diagnosed 2026-05-11): every esbuild-emitted bundle defines an
    // IIFE-bound `__require2` shim that reads `typeof require` AT
    // MODULE LOAD TIME. In the CJS bin (`dist/index.js`) Node provides
    // `require` as a CJS-module global, so the IIFE binds `__require2`
    // to Node's real `require` and externalized packages resolve
    // normally. In an ESM module no such global exists; the IIFE falls
    // through to a Proxy wrapping a throw-fallback function, and every
    // `__require2("X")` inside a `__commonJS`-wrapped module body
    // throws `Dynamic require of "X" is not supported` the moment it
    // executes. p-limit was the first such call hit on chat startup
    // because agent-loop's top imports it; the same crash would have
    // surfaced for every other externalized CJS-side dep otherwise.
    //
    // `module.createRequire(import.meta.url)` builds a real `require`
    // function rooted at this bundle's own URL. Declared at file scope
    // BEFORE esbuild's prologue executes, the IIFE captures it and
    // `__require2 = require`. External packages then resolve via
    // Node's normal node_modules walk from the published package's
    // location.
    //
    // Locked rule: do NOT add this banner to the CJS bin entry — its
    // `require` is already Node's CJS global, and prepending an ESM
    // `import` statement at the top of a CJS file is a syntax error.
    banner: {
      js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
    },
    external: [
      ...cliExternals,
      // ink + ink-text-input + react stay external in the ESM bundle
      // too — they're loaded via Node's ESM machinery at runtime, not
      // inlined. react-devtools-core stays external (ink imports it
      // optionally for dev tools; we don't ship it).
      "ink",
      "ink-text-input",
      "react",
      "react-devtools-core",
    ],
  },
]);
