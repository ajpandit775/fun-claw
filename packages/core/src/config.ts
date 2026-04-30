// Fun Claw configuration and secret loading.
//
// This module owns the precedence chain for user-facing configuration AND
// the lazy secret-loading path that backs `getSecret(provider)`. It is the
// one place that touches the filesystem for config / keyfile concerns.
//
// Precedence (highest wins) for user-facing config:
//   1. CLI flags (`options.cliOverrides` from the caller, typically commander)
//   2. Environment variables (`FUNCLAW_*`)
//   3. Project config (cosmiconfig, walking up from cwd)
//   4. User config (TOML at env-paths user config dir)
//   5. Built-in defaults (Zod schema `.default()` values)
//
// Precedence for secrets is deliberately narrower (env → keyfile only). The
// TOML config schema is `FullConfigSchema.omit({ secrets: true })`, so
// putting `[secrets]` in `funclaw.config.toml` triggers `.strict()`
// rejection, caught and re-thrown as `FC-2003` with an actionable message.
// The keyfile schema is `FullConfigSchema.pick({ secrets: true })` — same
// source-of-truth Zod parent type, two narrow consumers. See the
// 2026-04-28 "Slice 2, Q2" CLAUDE.md feedback entry for the rationale.
//
// Reference docs:
//   - .claude/CLAUDE.md (Error handling contract; FC-2xxx, FC-5xxx)
//   - STACK.md (Configuration: cosmiconfig, env-paths, smol-toml, Zod)
//   - REQUIREMENTS.md (Authentication, keyfile at ~/.funclaw/keys.json)
//   - docs/adr/ADR-001-trust-boundaries.md (API keys never enter the
//     container; never logged)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import envPaths from "env-paths";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { funClawError } from "./errors.js";
import type { FunClawLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The four LLM provider identifiers Fun Claw supports per REQUIREMENTS.md
 * "Hard constraints". `openai-compatible` covers the OpenAI-shaped APIs
 * (Together, Groq, OpenRouter, Ollama via baseURL override).
 */
export const ProviderSchema = z.enum(["anthropic", "openai", "gemini", "openai-compatible"]);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Container network mode. CLAUDE.md "Key rules" forbids `--network=host`
 * for any container Fun Claw spawns; the only sensible options are
 * `bridge` (default isolated network) and `none` (no network).
 */
export const NetworkModeSchema = z.enum(["bridge", "none"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

/** Pino log levels. Mirrors `LogLevel` in logger.ts (cannot import directly
 *  to keep this Zod schema standalone; the runtime values are identical). */
export const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

/**
 * Per-server MCP configuration. Keyed by user-chosen server name in
 * the parent `mcp` object (server name is the table key in TOML, the
 * object key in JSON / JS). The shape is locked by the Slice 7
 * kickoff:
 *
 *   - `command` is required: the executable to spawn for stdio
 *     transport.
 *   - `args` is optional: extra argv items.
 *   - `env` is optional: env vars merged ON TOP OF `process.env`
 *     when the subprocess is spawned. `undefined` means "inherit
 *     parent env unchanged" (the SDK's `getDefaultEnvironment()`
 *     filters for safe inheritance).
 *   - `enabled` defaults to `true`. Lets users temporarily disable
 *     a server without removing the table.
 *
 * Per the Slice 7 saved-feedback rule, transport is stdio-only for
 * v1; HTTP/SSE/WebSocket are `[v2-or-never]` so there is no
 * `transport` field here. Adding one would imply a commitment we
 * have not made.
 */
export const McpServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Top-level `mcp` config: a record of server name → server config.
 * The server name is what shows up in tool prefixes
 * (`mcp__<server>__<tool>`) and in log lines, so users should pick
 * something short and grep-friendly. We don't impose a format
 * constraint at the schema level — any non-empty string key is
 * accepted; a poor choice is the user's choice.
 *
 * `z.record` with a string-typed key (not an enum) is the right
 * shape here per the Slice 2 saved-feedback entry: enum-keyed
 * records are total in Zod 4, but string-keyed records are partial.
 */
export const McpConfigSchema = z.record(z.string().min(1), McpServerConfigSchema);
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Per-provider secrets schema. Written as an explicit object with one
 * optional field per provider (rather than `z.record(ProviderSchema, ...)`)
 * because Zod 4's `z.record` with an enum key schema is *total* — all
 * enum keys must be present — which is the wrong shape for a partial
 * keyfile. Explicit fields also make this self-documenting at the schema
 * level: a reader can see which providers are valid keys without chasing
 * the enum.
 */
const SecretsSchema = z
  .object({
    anthropic: z.string().min(1).optional(),
    openai: z.string().min(1).optional(),
    gemini: z.string().min(1).optional(),
    "openai-compatible": z.string().min(1).optional(),
  })
  .strict();

/**
 * The single source-of-truth schema. Two narrow consumers below derive
 * from it via `.omit` / `.pick`, so adding a field here automatically
 * flows through. `secrets` is part of this parent type ONLY so the
 * keyfile schema can pick it; the user-config TOML schema omits it.
 */
const FullConfigSchema = z
  .object({
    provider: ProviderSchema.default("anthropic"),
    defaultModel: z.string().min(1).optional(),
    workingDir: z.string().min(1).optional(),
    logLevel: LogLevelSchema.default("info"),
    runtimeImage: z.string().min(1).optional(),
    networkMode: NetworkModeSchema.default("bridge"),
    /**
     * Provider endpoint base URL. Required when `provider ===
     * "openai-compatible"` (Together, Groq, OpenRouter, Ollama, etc.);
     * harmless override for other providers if a user wants to point
     * at a proxy. Validated as a URL when present.
     */
    endpoint: z.string().url().optional(),
    /**
     * Optional MCP server table. Empty / missing means no MCP servers
     * — that's fine, MCP is opt-in (per Slice 7 kickoff). The shape is
     * `{ [serverName]: McpServerConfig }`; users author this in TOML as
     * `[mcp.<name>]` tables.
     */
    mcp: McpConfigSchema.optional(),
    secrets: SecretsSchema.optional(),
  })
  .strict();

/**
 * The user-facing configuration shape (TOML + project config + env + CLI).
 * Excludes `secrets` so a stray `[secrets]` table in `funclaw.config.toml`
 * triggers a strict-mode validation error caught by `loadConfig` and
 * re-thrown as `FC-2003` with an actionable message.
 *
 * `superRefine` enforces "endpoint required when provider is
 * 'openai-compatible'" at schema-validation time so `loadConfig` fails
 * fast with a clear error before the factory ever runs. The
 * `createProvider` factory still throws `FC-2008` as a runtime backstop
 * for the rare case where a malformed config bypasses Zod (per the
 * 2026-04-28 saved-feedback entry).
 */
export const UserConfigSchema = FullConfigSchema.omit({
  secrets: true,
})
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.provider === "openai-compatible" &&
      (data.endpoint === undefined || data.endpoint === "")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "endpoint is required when provider is 'openai-compatible'. " +
          'Set FUNCLAW_ENDPOINT in your environment, or `endpoint = "https://..."` in your config.',
        path: ["endpoint"],
      });
    }
  });
export type UserConfig = z.infer<typeof UserConfigSchema>;

/** The keyfile schema (`~/.funclaw/keys.json`). Just the secrets section. */
export const KeyfileSchema = FullConfigSchema.pick({
  secrets: true,
}).strict();
export type Keyfile = z.infer<typeof KeyfileSchema>;

// ---------------------------------------------------------------------------
// Provider → env-var name mapping
// ---------------------------------------------------------------------------

/**
 * Standard environment variable names per REQUIREMENTS.md "Authentication".
 * `openai-compatible` shares `OPENAI_API_KEY` with `openai` because the
 * OpenAI SDK reads that env var natively when wired with a `baseURL`
 * override; users wanting separate keys put them in the keyfile.
 */
const ENV_VAR_BY_PROVIDER: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GOOGLE_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

/**
 * `FUNCLAW_*` env var names mapped to user-config fields. Anything not in
 * this list is ignored (the env layer is for known fields only, not a
 * pass-through into the config namespace).
 */
const ENV_OVERRIDE_MAP: ReadonlyArray<readonly [string, keyof UserConfig]> = [
  ["FUNCLAW_PROVIDER", "provider"],
  ["FUNCLAW_MODEL", "defaultModel"],
  ["FUNCLAW_WORKING_DIR", "workingDir"],
  ["FUNCLAW_LOG_LEVEL", "logLevel"],
  ["FUNCLAW_RUNTIME_IMAGE", "runtimeImage"],
  ["FUNCLAW_NETWORK_MODE", "networkMode"],
  ["FUNCLAW_ENDPOINT", "endpoint"],
];

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Working directory for project-config search. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the user-config TOML path. Defaults to env-paths' user config
   *  dir + `/config.toml`. Pass an absolute path for testing. */
  userConfigPath?: string;
  /** CLI overrides (highest precedence). Typically populated by commander. */
  cliOverrides?: Partial<UserConfig>;
}

/**
 * Resolve the active configuration by walking the precedence chain:
 *
 *   defaults < user TOML < project (cosmiconfig) < FUNCLAW_* env < CLI
 *
 * Throws `FC-2003` if `funclaw.config.toml` contains a `[secrets]` table.
 * Throws `FC-5004` for non-secrets-related config errors so the caller can
 * distinguish parse / schema failures from secret-loading failures.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<UserConfig> {
  const cwd = options.cwd ?? process.cwd();
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath();

  const userLayer = loadUserConfigToml(userConfigPath);
  const projectLayer = await loadProjectConfig(cwd);
  const envLayer = readEnvOverrides();
  const cliLayer = options.cliOverrides ?? {};

  // Compact merge: skip undefined so a higher-precedence layer's omission
  // doesn't blow away a lower-precedence layer's value. Defaults come from
  // the schema's `.parse()`, applied at the very end.
  const merged: Record<string, unknown> = {};
  for (const layer of [userLayer, projectLayer, envLayer, cliLayer]) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) merged[k] = v;
    }
  }

  const result = UserConfigSchema.safeParse(merged);
  if (!result.success) {
    throw funClawError({
      code: "FC-5004",
      message: `Config validation failed: ${formatZodIssues(result.error)}`,
      cause: result.error,
      data: { merged },
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// getSecret
// ---------------------------------------------------------------------------

export interface GetSecretOptions {
  /** Override the keyfile path (default: `~/.funclaw/keys.json`). */
  keyfilePath?: string;
  /** Logger for the one-time Windows ACL warning. Optional. */
  logger?: FunClawLogger;
}

/** Module-level flag so the Windows ACL warning fires at most once per process. */
let windowsAclWarningEmitted = false;

/**
 * Resolve an API key for a provider. Precedence:
 *   1. The provider's standard env var (`ANTHROPIC_API_KEY`, etc.).
 *   2. `~/.funclaw/keys.json` (or `options.keyfilePath`).
 *
 * Per the Slice 2 Q2 decision (CLAUDE.md saved feedback), the user-config
 * TOML is **not** a secret source — secrets cannot be set there. This
 * function strictly checks env then keyfile.
 *
 * Throws `FunClawError` with the appropriate code on failure:
 *   - `FC-2001` — no key found in env or keyfile
 *   - `FC-2002` — env var is set but empty
 *   - `FC-5001` — keyfile mode is not 0600 on POSIX
 *   - `FC-5002` — explicit keyfile path was provided but file is missing
 *   - `FC-5003` — keyfile is not readable (permissions)
 *   - `FC-5005` — keyfile JSON is invalid or fails schema validation
 */
export function getSecret(provider: Provider, options: GetSecretOptions = {}): string {
  const envVarName = ENV_VAR_BY_PROVIDER[provider];

  // (1) Env var first.
  const envValue = process.env[envVarName];
  if (envValue !== undefined) {
    if (envValue === "") {
      throw funClawError({
        code: "FC-2002",
        message:
          `Environment variable ${envVarName} is set but empty. ` +
          `Either set a non-empty value or unset the variable to fall back to the keyfile.`,
        data: { provider, envVarName },
      });
    }
    return envValue;
  }

  // (2) Keyfile fallback.
  const explicitPath = options.keyfilePath !== undefined;
  const keyfilePath = options.keyfilePath ?? getDefaultKeyfilePath();

  if (!fs.existsSync(keyfilePath)) {
    if (explicitPath) {
      throw funClawError({
        code: "FC-5002",
        message:
          `Keyfile expected at ${keyfilePath} but the file does not exist. ` +
          `Create it with chmod 0600 and the JSON shape ` +
          `{ "secrets": { "${provider}": "your-key" } }.`,
        data: { keyfilePath, provider },
      });
    }
    throw funClawError({
      code: "FC-2001",
      message:
        `No API key for ${provider}. Set ${envVarName} in your environment, ` +
        `or create ${keyfilePath} with chmod 0600 and the JSON shape ` +
        `{ "secrets": { "${provider}": "your-key" } }.`,
      data: { provider, envVarName, keyfilePath },
    });
  }

  // (3) Mode check (POSIX) or one-time warning (Windows).
  enforceKeyfileMode(keyfilePath, options.logger);

  // (4) Read + parse + validate.
  let raw: string;
  try {
    raw = fs.readFileSync(keyfilePath, "utf8");
  } catch (cause) {
    throw funClawError({
      code: "FC-5003",
      message: `Keyfile at ${keyfilePath} is not readable.`,
      cause,
      data: { keyfilePath },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw funClawError({
      code: "FC-5005",
      message: `Keyfile at ${keyfilePath} is not valid JSON.`,
      cause,
      data: { keyfilePath },
    });
  }

  const result = KeyfileSchema.safeParse(parsed);
  if (!result.success) {
    throw funClawError({
      code: "FC-5005",
      message: `Keyfile at ${keyfilePath} did not match the expected schema: ${formatZodIssues(result.error)}`,
      cause: result.error,
      data: { keyfilePath },
    });
  }

  // Optional-chain access keeps `exactOptionalPropertyTypes` happy:
  // Zod's `.optional()` produces `string | undefined`, which doesn't
  // narrow cleanly through a `Partial<Record<...>>` annotation.
  const key = result.data.secrets?.[provider];
  if (key === undefined) {
    throw funClawError({
      code: "FC-2001",
      message:
        `No API key for ${provider}. Set ${envVarName} in your environment ` +
        `or add a "${provider}" entry to the "secrets" object in ${keyfilePath}.`,
      data: { provider, envVarName, keyfilePath },
    });
  }
  return key;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Public helper: the default path for the user-config TOML, derived from
 * env-paths' OS-correct user config directory. Used by `funclaw init` to
 * decide where to write the config it builds, and by future doctor /
 * config-edit commands to surface the path to the user.
 */
export function getDefaultUserConfigPath(): string {
  // env-paths resolves to `%APPDATA%\funclaw-nodejs\Config\` on
  // Windows, `~/Library/Application Support/funclaw-nodejs/Config/`
  // on macOS, and `$XDG_CONFIG_HOME/funclaw-nodejs/` on Linux.
  // Verified end-to-end on Windows through Slice 7 inline test +
  // Slice 10's doctor deliverable run; see
  // `docs/cross-platform.md`.
  const paths = envPaths("funclaw");
  return path.join(paths.config, "config.toml");
}

/**
 * Public helper: the default keyfile path (`~/.funclaw/keys.json` per
 * REQUIREMENTS.md "Authentication"). Used by `funclaw init` to surface
 * the path in the keyfile-setup outro and to optionally pre-create the
 * file with mode 0600 on POSIX.
 *
 * Note this is a deliberate deviation from env-paths' user data dir —
 * the spec chose a dotfile-style path for the keyfile specifically.
 */
export function getDefaultKeyfilePath(): string {
  return path.join(os.homedir(), ".funclaw", "keys.json");
}

/**
 * Read `userConfigPath` if it exists, parse as TOML via smol-toml,
 * validate against UserConfigSchema. Returns `{}` if the file is absent.
 *
 * Special-cases `[secrets]` rejection: `.strict()` produces an
 * `unrecognized_keys` issue at path `["secrets"]`, which we re-throw as
 * `FC-2003` with the locked actionable message.
 */
function loadUserConfigToml(userConfigPath: string): Partial<UserConfig> {
  if (!fs.existsSync(userConfigPath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(userConfigPath, "utf8");
  } catch (cause) {
    throw funClawError({
      code: "FC-5004",
      message: `User config at ${userConfigPath} is not readable.`,
      cause,
      data: { userConfigPath },
    });
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (cause) {
    throw funClawError({
      code: "FC-5004",
      message: `User config at ${userConfigPath} is not valid TOML.`,
      cause,
      data: { userConfigPath },
    });
  }

  const result = UserConfigSchema.safeParse(parsed);
  if (!result.success) {
    if (mentionsSecretsKey(result.error)) {
      throw funClawError({
        code: "FC-2003",
        message:
          "API keys cannot be set in funclaw.config.toml for security reasons. " +
          "Set them via environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY) " +
          "or in ~/.funclaw/keys.json. See docs/troubleshooting.md FC-2003.",
        cause: result.error,
        data: { userConfigPath },
      });
    }
    throw funClawError({
      code: "FC-5004",
      message: `User config at ${userConfigPath} failed validation: ${formatZodIssues(result.error)}`,
      cause: result.error,
      data: { userConfigPath },
    });
  }
  return result.data;
}

/**
 * Discover a project-level config file via cosmiconfig, walking up from
 * `cwd`. Supports `.js` / `.cjs` / `.mjs` / `.json` and the rc variants;
 * `.ts` is `[v2-or-never: cosmiconfig .ts loader — needs
 * cosmiconfig-typescript-loader + ts-node, defer until users ask]`.
 */
async function loadProjectConfig(cwd: string): Promise<Partial<UserConfig>> {
  const explorer = cosmiconfig("funclaw", {
    searchPlaces: [
      "package.json",
      ".funclawrc",
      ".funclawrc.json",
      "funclaw.config.json",
      "funclaw.config.js",
      "funclaw.config.cjs",
      "funclaw.config.mjs",
    ],
  });
  const result = await explorer.search(cwd);
  if (result === null || result.isEmpty === true) return {};

  const validated = UserConfigSchema.safeParse(result.config);
  if (!validated.success) {
    if (mentionsSecretsKey(validated.error)) {
      throw funClawError({
        code: "FC-2003",
        message:
          `API keys cannot be set in project config (${result.filepath}) for security reasons. ` +
          "Set them via environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY) " +
          "or in ~/.funclaw/keys.json. See docs/troubleshooting.md FC-2003.",
        cause: validated.error,
        data: { filepath: result.filepath },
      });
    }
    throw funClawError({
      code: "FC-5004",
      message: `Project config at ${result.filepath} failed validation: ${formatZodIssues(validated.error)}`,
      cause: validated.error,
      data: { filepath: result.filepath },
    });
  }
  return validated.data;
}

/** Read `FUNCLAW_*` env vars and project them into a UserConfig partial. */
function readEnvOverrides(): Partial<UserConfig> {
  const out: Record<string, unknown> = {};
  for (const [envName, key] of ENV_OVERRIDE_MAP) {
    const value = process.env[envName];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as Partial<UserConfig>;
}

/**
 * On POSIX, throws `FC-5001` if the keyfile mode is not 0600. On Windows,
 * the deliberate non-enforcement: print a one-time warning per process and
 * proceed. ACL enforcement on Windows is `[v2-or-never: keyfile-acl —
 * outside v1 scope, container isolation is the primary boundary]`.
 */
function enforceKeyfileMode(keyfilePath: string, logger: FunClawLogger | undefined): void {
  // Deliberate non-enforcement of POSIX-style file modes on Windows.
  // Windows ACLs are a separate enforcement model that v1 does not
  // attempt; the once-per-process warning below tells users to manage
  // the ACL themselves via Properties → Security. See
  // `docs/cross-platform.md` and the FC-5001 troubleshooting entry.
  if (process.platform === "win32") {
    if (!windowsAclWarningEmitted) {
      windowsAclWarningEmitted = true;
      logger?.warn(
        { keyfilePath },
        "Keyfile permissions cannot be enforced on Windows; protect the file via OS ACL settings.",
      );
    }
    return;
  }

  const stat = fs.statSync(keyfilePath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    const modeOctal = mode.toString(8).padStart(3, "0");
    throw funClawError({
      code: "FC-5001",
      message:
        `Keyfile ${keyfilePath} has unsafe permissions ${modeOctal} — should be 0600. ` +
        `Run: chmod 0600 ${keyfilePath}`,
      data: { keyfilePath, currentMode: modeOctal, expectedMode: "600" },
    });
  }
}

/** Tighten Zod issues into a single grep-friendly line for an error message. */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * True if a `.strict()` validation failure is specifically about a
 * `secrets` key at the top level (the "no secrets in TOML" case).
 */
function mentionsSecretsKey(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" &&
      Array.isArray((issue as { keys?: unknown }).keys) &&
      (issue as { keys: string[] }).keys.includes("secrets"),
  );
}
