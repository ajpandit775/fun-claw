// Vitest tests for `loadConfig` + `getSecret`.
//
// Both helpers touch the real filesystem — they take TOML / JSON
// paths as arguments and read them. Tests use real temp dirs (per
// the Slice 8 saved-feedback rule about real fs vs memfs for
// readability semantics) and clean up via `afterEach`.
//
// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access on
// `process.env` is required by TypeScript's
// noPropertyAccessFromIndexSignature; biome's useLiteralKeys would
// rewrite `process.env["VAR"]` to `process.env.VAR`, which the TS
// compiler then rejects. Per the 2026-04-28 saved-feedback rule, the
// destructure pattern resolves the conflict for reads — but
// assignments and deletes still need bracket form. This file does
// both, so the rule is suppressed file-wide.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSecret, loadConfig } from "../config.js";
import { isFunClawError } from "../errors.js";

let tmpRoot: string;
let configPath: string;
let keyfilePath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-config-test-"));
  configPath = path.join(tmpRoot, "config.toml");
  keyfilePath = path.join(tmpRoot, "keys.json");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // Clear env vars the tests touch so cross-test isolation holds.
  // Destructure pattern per the 2026-04-28 saved feedback (Biome
  // useLiteralKeys vs TS noPropertyAccessFromIndexSignature
  // conflict on bracket access against process.env). The deletes
  // here use bracket access because TS allows `delete obj[key]` on
  // index signatures even when it disallows reads.
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"] as const) {
    delete process.env[v];
  }
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig — happy paths", () => {
  it("loads a minimal anthropic config", async () => {
    fs.writeFileSync(
      configPath,
      'provider = "anthropic"\ndefaultModel = "claude-haiku-4-5"\n',
      "utf8",
    );
    const cfg = await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.defaultModel).toBe("claude-haiku-4-5");
    expect(cfg.networkMode).toBe("bridge"); // default
    expect(cfg.logLevel).toBe("info"); // default
  });

  it("falls back to defaults when no config file exists", async () => {
    // configPath does not exist — loadConfig returns the defaults.
    const cfg = await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    expect(cfg.provider).toBe("anthropic"); // default
    expect(cfg.networkMode).toBe("bridge");
    expect(cfg.logLevel).toBe("info");
  });

  it("loads an mcp section into cfg.mcp", async () => {
    fs.writeFileSync(
      configPath,
      `provider = "openai"
defaultModel = "gpt-4o-mini"

[mcp.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
`,
      "utf8",
    );
    const cfg = await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    expect(cfg.mcp).toBeDefined();
    // Bracket access satisfies noPropertyAccessFromIndexSignature
    // (cfg.mcp is a Record<string, ...>).
    expect(cfg.mcp?.["filesystem"]).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
  });
});

describe("loadConfig — error paths", () => {
  it("FC-2003 when [secrets] is in the TOML", async () => {
    fs.writeFileSync(
      configPath,
      `provider = "anthropic"

[secrets]
anthropic = "sk-should-not-be-here"
`,
      "utf8",
    );
    let caught: unknown;
    try {
      await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-2003");
    }
  });

  it("FC-5004 when the TOML has invalid syntax", async () => {
    fs.writeFileSync(configPath, "this is not = [valid: toml\n", "utf8");
    let caught: unknown;
    try {
      await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5004");
    }
  });

  it("FC-5004 when the schema rejects a malformed [mcp.<name>]", async () => {
    fs.writeFileSync(
      configPath,
      `provider = "openai"

[mcp.bad]
args = ["x"]
`, // missing required 'command'
      "utf8",
    );
    let caught: unknown;
    try {
      await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5004");
    }
  });

  it("FC-5004 when openai-compatible is set without endpoint", async () => {
    fs.writeFileSync(
      configPath,
      'provider = "openai-compatible"\ndefaultModel = "test-model"\n',
      "utf8",
    );
    let caught: unknown;
    try {
      await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5004");
    }
  });
});

describe("loadConfig — env var overrides", () => {
  it("FUNCLAW_PROVIDER overrides the TOML value", async () => {
    fs.writeFileSync(configPath, 'provider = "anthropic"\n', "utf8");
    process.env["FUNCLAW_PROVIDER"] = "openai";
    process.env["FUNCLAW_MODEL"] = "gpt-4o-mini";
    const cfg = await loadConfig({ userConfigPath: configPath, cwd: tmpRoot });
    expect(cfg.provider).toBe("openai");
    expect(cfg.defaultModel).toBe("gpt-4o-mini");
    delete process.env["FUNCLAW_PROVIDER"];
    delete process.env["FUNCLAW_MODEL"];
  });

  it("CLI overrides take precedence over env vars", async () => {
    fs.writeFileSync(configPath, 'provider = "anthropic"\n', "utf8");
    process.env["FUNCLAW_PROVIDER"] = "openai";
    const cfg = await loadConfig({
      userConfigPath: configPath,
      cwd: tmpRoot,
      cliOverrides: { provider: "gemini", defaultModel: "gemini-2.5-flash" },
    });
    expect(cfg.provider).toBe("gemini");
    expect(cfg.defaultModel).toBe("gemini-2.5-flash");
    delete process.env["FUNCLAW_PROVIDER"];
  });
});

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------

describe("getSecret — env var precedence", () => {
  it("returns the env var when set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-from-env";
    const key = getSecret("anthropic", { keyfilePath });
    expect(key).toBe("sk-ant-from-env");
  });

  it("FC-2002 when the env var is set but empty", () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    let caught: unknown;
    try {
      getSecret("anthropic", { keyfilePath });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-2002");
    }
  });

  it("FC-5002 when an explicit keyfile path is provided but missing (and no env var)", () => {
    // Note: when getSecret is called with an EXPLICIT keyfilePath
    // option (as the tests do above for isolation), the absence of
    // that file produces FC-5002 — distinct from FC-2001 which only
    // fires when the DEFAULT keyfile path doesn't exist. The Slice
    // 2 saved feedback distinguishes "no key found anywhere"
    // (FC-2001) from "you asked for this specific keyfile and it
    // wasn't there" (FC-5002).
    let caught: unknown;
    try {
      getSecret("anthropic", { keyfilePath });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5002");
    }
  });
});

describe("getSecret — keyfile path", () => {
  it("falls back to keyfile when env var is not set", () => {
    fs.writeFileSync(
      keyfilePath,
      JSON.stringify({ secrets: { anthropic: "sk-ant-from-keyfile" } }),
      "utf8",
    );
    if (process.platform !== "win32") fs.chmodSync(keyfilePath, 0o600);
    const key = getSecret("anthropic", { keyfilePath });
    expect(key).toBe("sk-ant-from-keyfile");
  });

  it("FC-5005 when the keyfile is not valid JSON", () => {
    fs.writeFileSync(keyfilePath, "{not valid json", "utf8");
    if (process.platform !== "win32") fs.chmodSync(keyfilePath, 0o600);
    let caught: unknown;
    try {
      getSecret("anthropic", { keyfilePath });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5005");
    }
  });

  it("FC-5005 when the keyfile has the wrong shape", () => {
    fs.writeFileSync(keyfilePath, JSON.stringify({ wrong: "shape" }), "utf8");
    if (process.platform !== "win32") fs.chmodSync(keyfilePath, 0o600);
    let caught: unknown;
    try {
      getSecret("anthropic", { keyfilePath });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-5005");
    }
  });

  it("FC-2001 when the keyfile is valid but missing the requested provider", () => {
    fs.writeFileSync(
      keyfilePath,
      JSON.stringify({ secrets: { openai: "sk-only-openai" } }),
      "utf8",
    );
    if (process.platform !== "win32") fs.chmodSync(keyfilePath, 0o600);
    let caught: unknown;
    try {
      getSecret("anthropic", { keyfilePath });
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe("FC-2001");
    }
  });
});
