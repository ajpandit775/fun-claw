// `funclaw init` — first-run setup wizard.
//
// Flow:
//   - @clack/prompts intro / group / outro.
//   - Provider select, default-model text, conditional endpoint text
//     (only for openai-compatible), workingDir text, runtimeImage text,
//     logLevel select.
//   - Validate via UserConfigSchema (which includes the superRefine
//     "endpoint required for openai-compatible" rule).
//   - Confirm path before writing; pretty-print TOML via smol-toml.
//   - Best-effort Docker daemon check via `docker info` through execa
//     (full diagnostic checks belong in `funclaw doctor`).
//   - Outro that explains how to set the API key (env var or keyfile)
//     and optionally pre-creates the keyfile + opens it in the user's
//     editor.
//
// The wizard does NOT prompt for the API key itself — secret entry is
// its own UX challenge (echo suppression, validation, retry on bad keys)
// and the `getSecret` chain in @funclaw/core already handles env vars
// and the keyfile cleanly. Honest about what we are and aren't good at.
//
// Reference docs:
//   - REQUIREMENTS.md Flow 1 (the install + setup flow this implements).
//   - .claude/CLAUDE.md "Saved feedback" — particularly the runtime-image
//     default note and the @clack/prompts ^1.2 pin.
//   - STACK.md "CLI and TUI" (commander 14, @clack/prompts ^1.2).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cancel,
  confirm,
  group,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  type FunClawLogger,
  getDefaultKeyfilePath,
  getDefaultUserConfigPath,
  loadConfig,
  type Provider,
  type UserConfig,
  UserConfigSchema,
} from "@funclaw/core";
import type { Command } from "commander";
import { execa } from "execa";
import { stringify as stringifyToml } from "smol-toml";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS: Array<{
  value: Provider;
  label: string;
  hint?: string;
}> = [
  {
    value: "anthropic",
    label: "Anthropic Claude",
    hint: "claude-haiku-4-5, claude-sonnet-4-5, ...",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "gpt-4o, gpt-4o-mini, gpt-5, ...",
  },
  {
    value: "gemini",
    label: "Google Gemini",
    hint: "gemini-2.5-flash, gemini-2.5-pro, ...",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible (Together, Groq, OpenRouter, Ollama)",
    hint: "needs an endpoint URL",
  },
];

const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<Provider, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
  "openai-compatible": "",
};

const ENV_VAR_BY_PROVIDER: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GOOGLE_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerInit(program: Command, logger: FunClawLogger): void {
  program
    .command("init")
    .description("first-run setup wizard")
    .action(async () => {
      await runInitWizard(logger);
    });
}

// ---------------------------------------------------------------------------
// Wizard flow
// ---------------------------------------------------------------------------

export async function runInitWizard(logger: FunClawLogger): Promise<void> {
  intro("Welcome to Fun Claw — let's get you set up.");

  const answers = await group(
    {
      provider: () =>
        select<Provider>({
          message: "Which LLM provider should Fun Claw use?",
          options: PROVIDER_OPTIONS,
          initialValue: "anthropic",
        }),
      model: ({ results }) => {
        const provider = results.provider as Provider;
        const initial = DEFAULT_MODEL_BY_PROVIDER[provider];
        const isOpenAICompatible = provider === "openai-compatible";
        return text({
          message: isOpenAICompatible
            ? "Which model should Fun Claw use? (depends on your endpoint — check its docs)"
            : "Which model should Fun Claw use?",
          ...(initial !== "" ? { initialValue: initial } : {}),
          ...(isOpenAICompatible ? { placeholder: "e.g. meta-llama/Llama-3-70b-instruct" } : {}),
          validate: (value) => {
            if (value === undefined || value.length === 0) {
              return "Please name a model.";
            }
            return undefined;
          },
        });
      },
      endpoint: async ({ results }) => {
        if (results.provider !== "openai-compatible") return undefined;
        return text({
          message: "Endpoint URL for the OpenAI-compatible provider:",
          placeholder: "https://api.together.xyz/v1",
          validate: (value) => {
            if (value === undefined || value.length === 0) {
              return "Endpoint is required.";
            }
            try {
              // Side-effect parse — `new URL()` throws on invalid input.
              new URL(value);
              return undefined;
            } catch {
              return "Must be a valid URL (e.g. https://api.together.xyz/v1).";
            }
          },
        });
      },
      workingDir: () =>
        text({
          message: "Where should Fun Claw work from? (the agent's default workspace)",
          initialValue: process.cwd(),
        }),
      runtimeImage: () =>
        text({
          message: "Which Docker image should the sandbox use?",
          initialValue: "ghcr.io/ajpandit775/fun-claw-runtime:0.1.0",
        }),
      logLevel: () =>
        select({
          message: "How chatty should Fun Claw be in its logs?",
          options: [
            {
              value: "info",
              label: "info — normal output (default)",
            },
            {
              value: "debug",
              label: "debug — verbose, useful when something's wrong",
            },
            {
              value: "trace",
              label: "trace — everything, rarely what you want",
            },
          ],
          initialValue: "info",
        }),
    },
    {
      onCancel: () => {
        cancel("Setup cancelled — your config has not changed.");
        process.exit(130);
      },
    },
  );

  // group() with onCancel(process.exit) means we only reach here on
  // success. @clack/prompts' inferred result type doesn't propagate
  // through the prompt-function generics strongly, so each field comes
  // back as `unknown`; casts here are safe because the wizard control
  // flow guarantees the answers shape.
  const draft: UserConfig = {
    provider: answers.provider as Provider,
    defaultModel: answers.model as string,
    workingDir: answers.workingDir as string,
    runtimeImage: answers.runtimeImage as string,
    networkMode: "bridge",
    logLevel: answers.logLevel as UserConfig["logLevel"],
    ...(answers.endpoint !== undefined ? { endpoint: answers.endpoint as string } : {}),
  };

  const validated = UserConfigSchema.safeParse(draft);
  if (!validated.success) {
    cancel(`Validation failed: ${validated.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }

  // Confirm write path
  const userConfigPath = getDefaultUserConfigPath();
  const writeOk = await confirm({
    message: `Write config to ${userConfigPath}?`,
    initialValue: true,
  });
  if (isCancel(writeOk)) {
    cancel("Setup cancelled — your config has not changed.");
    process.exit(130);
  }
  if (writeOk !== true) {
    cancel("Setup aborted — config not written.");
    process.exit(0);
  }

  await writeConfigToml(userConfigPath, validated.data, logger);
  log.success(`Wrote ${userConfigPath}`);

  // Round-trip sanity check: load back what we just wrote.
  try {
    const reloaded = await loadConfig({ userConfigPath });
    log.success(
      `Config round-trips cleanly (provider=${reloaded.provider}, model=${reloaded.defaultModel ?? "<none>"}).`,
    );
    logger.debug({ reloaded }, "init wizard reloaded config");
  } catch (err) {
    log.warn(
      `Config written, but loadConfig() round-trip failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    logger.warn({ err }, "init wizard round-trip failed");
  }

  await dockerCheck(logger);

  await keyfileGuidance(answers.provider, logger);

  outro(
    "All set. Try `funclaw doctor` to verify your environment, then `funclaw chat` to start a conversation.",
  );
}

// ---------------------------------------------------------------------------
// Internals (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Write a validated `UserConfig` to a TOML file at `filePath`. Creates
 * the parent directory if needed. Exposed for round-trip smoke
 * testing; the wizard above is the production caller.
 */
export async function writeConfigToml(
  filePath: string,
  config: UserConfig,
  logger: FunClawLogger,
): Promise<void> {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // smol-toml's stringify takes any plain object. Strip undefined fields
  // because TOML doesn't have a concept of "absent vs undefined".
  const tomlData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) tomlData[key] = value;
  }

  const tomlText = stringifyToml(tomlData);
  fs.writeFileSync(filePath, `${tomlText}\n`, "utf8");
  logger.info({ filePath }, "wrote user config TOML");
}

/**
 * Best-effort Docker daemon reachability check via `execa`.
 * Intentionally lightweight — full diagnostic checks live in
 * `funclaw doctor`. STACK.md's "spawning docker CLI as a subprocess"
 * prohibition is for sandbox/container operations; a version probe
 * is outside that scope.
 */
async function dockerCheck(logger: FunClawLogger): Promise<void> {
  const s = spinner();
  s.start("Checking Docker daemon");
  try {
    const result = await execa("docker", ["version", "--format", "{{.Server.Version}}"], {
      reject: false,
      timeout: 5000,
    });
    const version = result.stdout?.trim() ?? "";
    if (result.exitCode === 0 && version.length > 0) {
      s.stop(`Docker daemon reachable (server v${version}).`);
      logger.info({ version }, "Docker daemon reachable");
      return;
    }
    s.stop(
      "Docker not reachable — install Docker Desktop, then run `funclaw doctor` for diagnostics.",
    );
    logger.warn({ exitCode: result.exitCode }, "Docker daemon not reachable");
  } catch (err) {
    s.stop(
      "Docker not reachable — install Docker Desktop, then run `funclaw doctor` for diagnostics.",
    );
    logger.warn({ err }, "Docker check threw");
  }
}

/**
 * Print the API-key-setup outro and offer to pre-create the keyfile +
 * open it in the user's editor. Pure side-effect, no return value.
 */
async function keyfileGuidance(provider: Provider, logger: FunClawLogger): Promise<void> {
  const envVar = ENV_VAR_BY_PROVIDER[provider];
  const keyfilePath = getDefaultKeyfilePath();

  log.info(`Fun Claw needs an API key for ${provider}. Two ways to set it:`);
  log.message(`  1. Set ${envVar} in your shell — Fun Claw reads it on every run.`);
  log.message(
    `  2. Add a "${provider}" entry to ${keyfilePath}:\n     { "secrets": { "${provider}": "<your-key>" } }`,
  );
  log.message("  (Env vars take precedence over the keyfile; pick whichever fits your workflow.)");

  const wantHelp = await confirm({
    message: "Want me to create the keyfile and open it in your editor?",
    initialValue: false,
  });
  if (isCancel(wantHelp) || wantHelp !== true) return;

  await createAndOpenKeyfile(keyfilePath, provider, logger);
}

async function createAndOpenKeyfile(
  keyfilePath: string,
  provider: Provider,
  logger: FunClawLogger,
): Promise<void> {
  // Pre-create directory + file with empty secrets stub. Mode 0o700 on
  // POSIX so the directory itself is owner-only; mode 0o600 on the
  // file. On Windows the mode bits are mostly ignored — Windows ACLs
  // are a separate enforcement model that v1 does not attempt. The
  // FC-5001 troubleshooting entry tells Windows users to manage
  // keyfile ACLs via Properties → Security; see
  // `docs/cross-platform.md` for the cross-platform notes.
  //
  // Edge cases the wizard handles gracefully:
  //   - parent directory missing: `mkdirSync({ recursive: true })`.
  //   - keyfile already exists: skip creation, open as-is.
  //   - keyfile path is a directory (rare misconfig): existsSync
  //     returns true; we skip writeFileSync and the editor open
  //     surfaces the directory in the editor (which usually means
  //     the editor refuses cleanly).
  //   - mkdir / writeFile permission failures: caught and surfaced as
  //     a `log.warn` with the path printed so the user can resolve
  //     manually. The wizard does NOT exit on these — the user can
  //     still set the env var instead, and `funclaw doctor` will
  //     pick that up.
  try {
    fs.mkdirSync(path.dirname(keyfilePath), { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn({ err, keyfilePath }, "could not create keyfile directory");
    log.warn(
      `Couldn't create ${path.dirname(keyfilePath)}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Set the env var instead, or create the directory manually and re-run `funclaw init`.",
    );
    return;
  }
  if (!fs.existsSync(keyfilePath)) {
    try {
      fs.writeFileSync(keyfilePath, `${JSON.stringify({ secrets: {} }, null, 2)}\n`, "utf8");
      if (process.platform !== "win32") {
        fs.chmodSync(keyfilePath, 0o600);
      }
      log.success(`Created ${keyfilePath}`);
    } catch (err) {
      logger.warn({ err, keyfilePath }, "could not create keyfile");
      log.warn(
        `Couldn't create ${keyfilePath}: ${err instanceof Error ? err.message : String(err)}. ` +
          "Set the env var instead, or create the file manually and re-run `funclaw init`.",
      );
      return;
    }
  } else {
    log.message(`${keyfilePath} already exists; opening as-is.`);
  }

  // Open in editor. Prefer $VISUAL / $EDITOR (terminal editors), fall
  // back to platform default. Best-effort — print the path on failure.
  //
  // Destructure rather than `process.env["VAR"]` because Biome's
  // `useLiteralKeys` and TypeScript's `noPropertyAccessFromIndexSignature`
  // directly conflict on bracket access against `process.env`. The
  // destructure form satisfies both — see the 2026-04-28 saved-feedback
  // entry on env-var access patterns.
  const { VISUAL, EDITOR } = process.env;
  const editor = VISUAL ?? EDITOR;
  try {
    if (editor !== undefined && editor.length > 0) {
      await execa(editor, [keyfilePath], { stdio: "inherit" });
    } else if (process.platform === "darwin") {
      await execa("open", [keyfilePath]);
    } else if (process.platform === "win32") {
      // `start` is a cmd builtin — invoking it via `cmd /c start ""
      // <path>` opens the file with its default Windows handler,
      // which respects the user's editor association if they've set
      // one. The empty `""` is the window title arg (omitting it
      // would make `start` interpret a path with spaces as the
      // title).
      await execa("cmd", ["/c", "start", "", keyfilePath]);
    } else {
      await execa("xdg-open", [keyfilePath]);
    }
    log.message(`Add your API key to "secrets.${provider}", save, and you're all set.`);
  } catch (err) {
    logger.warn({ err, keyfilePath }, "could not open keyfile in editor");
    log.warn(
      `Couldn't open the editor automatically — open ${keyfilePath} yourself when you're ready.`,
    );
  }
}

// `os` import is used inside the `getDefaultKeyfilePath` re-export from
// core; we import it here to keep the constant `process.platform` checks
// nearby and to avoid an unused-import warning. (No-op suppression for
// biome's unused-imports flag.)
void os;
