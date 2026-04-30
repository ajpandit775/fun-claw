import { defineConfig, type Options } from "tsup";

/**
 * Shared tsup options for every Fun Claw package.
 * Per-package `tsup.config.ts` files import { baseTsupOptions } from this file
 * and add their own `entry`. Those per-package configs are added in later slices
 * once each package has real source.
 *
 * Locked per STACK.md and the per-package `package.json` `type: commonjs`:
 *  - format: cjs only — Node SEA in Node 22 only supports CJS.
 *  - target: node22.
 *  - dts: true — declaration emission validated by @arethetypeswrong/cli in CI.
 *  - external: runtime peers that ride along instead of being bundled.
 */
export const baseTsupOptions: Options = {
  format: ["cjs"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    "dockerode",
    "@modelcontextprotocol/sdk",
    "@anthropic-ai/sdk",
    "openai",
    "@google/genai",
  ],
};

// Running `tsup` from the workspace root is not supported — there is nothing to
// build at the root. This default exists only so tsup can resolve the file when
// it discovers it at the root; per-package configs are where real builds live.
export default defineConfig(() => {
  throw new Error(
    "Run tsup from a package, not the workspace root. " +
      "Per-package tsup.config.ts files import { baseTsupOptions } from this file.",
  );
});
