// `funclaw doctor` — environment diagnostics.
//
// Replaces the Slice 4 stub with a five-check implementation per the
// Slice 10 kickoff. The doctor consumes existing infrastructure
// (loadConfig, getSecret, DockerRunner, createProvider) rather than
// reimplementing it — its job is to drive that infrastructure
// through enough success / failure paths that a user can diagnose
// their environment before running `funclaw chat`.
//
// Five checks, run in order:
//   1. Docker daemon reachable (FC-1001 / FC-1004 on failure).
//   2. Provider authentication: key present + 1-token ping that
//      verifies the key actually works (FC-2001 / FC-2002 / FC-2007 /
//      FC-2004 / FC-2005 / FC-2006 on failure).
//   3. Runtime image present locally (warn only — `--pull-image`
//      remediates).
//   4. Config file parses cleanly (FC-5004 / FC-5005 on failure).
//   5. Orphaned containers from past sessions (warn only —
//      `--clean` remediates).
//
// Flags:
//   --pull-image   pull the configured runtime image before the
//                  checks run (so check 3 will pass after).
//   --clean        destroy orphaned session containers (parent + any
//                  subagents grouped under them) before the checks
//                  run (so check 5 will pass after).
//   --json         emit structured JSON instead of the human-readable
//                  output. Used by CI integrations.
//
// Exit codes: 0 if all checks pass or warn; 1 if any fail.
//
// Reference docs:
//   - .claude/CLAUDE.md "Saved feedback" — the locked rule that every
//     FC code in source has a docs/troubleshooting.md entry; the
//     Slice 9 feedback that the doctor consumes
//     `listOrphanedSessions`'s `subagentId` field for grouped display.
//   - REQUIREMENTS.md Flow 6 — the doctor's role in the install flow.

import Anthropic from "@anthropic-ai/sdk";
import {
  createLogger,
  type FunClawError,
  type FunClawLogger,
  funClawError,
  getDefaultUserConfigPath,
  getSecret,
  isFunClawError,
  loadConfig,
  type Provider,
  type UserConfig,
} from "@funclaw/core";
import { DockerRunner, type OrphanedSessionInfo } from "@funclaw/docker-runner";
import { GoogleGenAI } from "@google/genai";
import type { Command } from "commander";
import Docker from "dockerode";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ms — daemon ping cap. Beyond this we give up and surface FC-1004. */
const DOCKER_PING_TIMEOUT_MS = 5_000;
/** ms — provider ping cap. Live LLM calls usually return in <1s; the
 *  cap is generous so a slow first connection on a cold network
 *  doesn't trip the doctor unnecessarily. */
const PROVIDER_PING_TIMEOUT_MS = 15_000;
/** Default mirrors chat.ts's DEFAULT_RUNTIME_IMAGE — the published
 *  runtime image at ghcr.io/ajpandit775/fun-claw-runtime. The doctor
 *  uses this when checking image presence locally; the user's
 *  config can override via `runtimeImage = "..."` in funclaw.config.toml. */
const DEFAULT_RUNTIME_IMAGE = "ghcr.io/ajpandit775/fun-claw-runtime:0.1.0";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("diagnose the Fun Claw environment")
    .option("--pull-image", "pull the configured runtime image before running checks")
    .option("--clean", "remove orphaned containers from past sessions before running checks")
    .option("--json", "emit structured JSON output instead of human-readable text")
    .action(async (options: { pullImage?: boolean; clean?: boolean; json?: boolean }) => {
      const exitCode = await runDoctor(options);
      process.exit(exitCode);
    });
}

// ---------------------------------------------------------------------------
// Check result vocabulary
// ---------------------------------------------------------------------------

/** Per-check outcome surfaced in the doctor's output. */
export interface CheckResult {
  id: string;
  /** Short human-readable check title (e.g. "Docker daemon"). */
  title: string;
  /** Outcome category: pass = green ✓; warn = yellow ⚠ (informational
   *  but doesn't fail the doctor); fail = red ✗ (process exits 1). */
  status: "pass" | "warn" | "fail";
  /** Detail line shown after the status mark. May span multiple
   *  lines (joined with `\n`). */
  detail: string;
  /** FunClawError code when applicable (failures usually carry one;
   *  warns sometimes carry one too). */
  code?: string;
}

interface DoctorOptions {
  pullImage?: boolean;
  clean?: boolean;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const logger = createLogger({ level: "warn", logFilePath: null, pretty: false });
  const useColor = !options.json && process.stdout.isTTY === true;

  if (!options.json) {
    process.stdout.write("Fun Claw doctor — checking your environment...\n\n");
  }

  // Pre-flight remediations (--pull-image, --clean) run BEFORE the
  // checks so the subsequent check pass reflects the new state.
  // Failures inside these pre-flights surface as their own
  // diagnostic lines but don't abort the rest of the run.
  let preflightConfig: UserConfig | undefined;
  try {
    preflightConfig = await loadConfig();
  } catch {
    // Config errors get caught by check 4 below; pre-flights that
    // need config (--pull-image with the configured image,
    // --clean with the runner) just skip silently and the user sees
    // the FC-5xxx in check 4.
  }

  if (options.pullImage === true && preflightConfig !== undefined) {
    await runPullImage(preflightConfig, useColor);
  }
  if (options.clean === true && preflightConfig !== undefined) {
    await runClean(preflightConfig, useColor);
  }

  // The five checks.
  const results: CheckResult[] = [];
  results.push(await checkDockerDaemon());
  results.push(await checkProviderAuth(preflightConfig, logger));
  results.push(await checkRuntimeImage(preflightConfig));
  results.push(await checkConfigParses());
  results.push(await checkOrphanedContainers(preflightConfig));

  // Report.
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      printCheckResultText(r, useColor);
    }
    printSummaryText(results, useColor);
  }

  return results.some((r) => r.status === "fail") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Check 1 — Docker daemon
// ---------------------------------------------------------------------------

async function checkDockerDaemon(): Promise<CheckResult> {
  // dockerode auto-detects the Unix socket on POSIX and the named
  // pipe (`\\.\pipe\docker_engine`) on Windows native; verified
  // working on the maintainer's Windows + Docker Desktop machine
  // through Slices 5/6/7/8/9 smokes.
  const docker = new Docker();
  let pingResult: { ok: true; version: string } | { ok: false; reason: string; code?: string };
  try {
    pingResult = await Promise.race([
      docker
        .version()
        .then((v) => ({
          ok: true as const,
          version: (v as { Version?: string }).Version ?? "unknown",
        }))
        .catch((err) => ({
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
          code: classifyDockerError(err),
        })),
      new Promise<{ ok: false; reason: string; code: string }>((_, reject) =>
        setTimeout(
          () =>
            reject({
              ok: false as const,
              reason: `daemon did not respond within ${DOCKER_PING_TIMEOUT_MS}ms`,
              code: "FC-1004",
            }),
          DOCKER_PING_TIMEOUT_MS,
        ),
      ).catch((e: { ok: false; reason: string; code: string }) => e),
    ]);
  } catch (err) {
    pingResult = {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      code: "FC-1001",
    };
  }

  if (pingResult.ok) {
    return {
      id: "docker-daemon",
      title: "Docker daemon",
      status: "pass",
      detail: `reachable (server v${pingResult.version})`,
    };
  }
  const code = pingResult.code ?? "FC-1001";
  const remediation =
    code === "FC-1004"
      ? "The socket is reachable but the daemon is hung. Restart Docker Desktop or your docker service."
      : "Install Docker Desktop (macOS / Windows) or start the docker service (Linux). See docs/troubleshooting.md FC-1001.";
  return {
    id: "docker-daemon",
    title: "Docker daemon",
    status: "fail",
    detail: `${pingResult.reason}. ${remediation}`,
    code,
  };
}

function classifyDockerError(err: unknown): string {
  if (err === null || typeof err !== "object") return "FC-1001";
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") return "FC-1001";
  return "FC-1001";
}

// ---------------------------------------------------------------------------
// Check 2 — Provider authentication
// ---------------------------------------------------------------------------

async function checkProviderAuth(
  config: UserConfig | undefined,
  logger: FunClawLogger,
): Promise<CheckResult> {
  if (config === undefined) {
    return {
      id: "provider-auth",
      title: "Provider authentication",
      status: "fail",
      detail:
        "Skipped — config did not load (see check 4 below). Run `funclaw init` if you have not yet.",
      code: "FC-5004",
    };
  }

  const provider = config.provider;
  const titleProvider = providerLabel(provider);
  const title = `Provider authentication (${titleProvider})`;

  // (a) Resolve the key — FC-2001/FC-2002 if absent.
  let apiKey: string;
  try {
    apiKey = getSecret(provider, { logger });
  } catch (err) {
    if (isFunClawError(err)) {
      return failureFromError(title, "provider-auth", err);
    }
    return {
      id: "provider-auth",
      title,
      status: "fail",
      detail: `Could not resolve API key: ${err instanceof Error ? err.message : String(err)}`,
      code: "FC-2001",
    };
  }

  // (b) 1-token ping. Different SDK shape per provider; the goal is
  // a single non-streaming request that round-trips authentication
  // and surfaces 401 / 429 / 503 with the right FC code.
  try {
    await Promise.race([
      providerPing(provider, apiKey, config),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              funClawError({
                code: "FC-2005",
                message: `${titleProvider} did not respond within ${PROVIDER_PING_TIMEOUT_MS}ms — provider may be unavailable.`,
                data: { provider, timeoutMs: PROVIDER_PING_TIMEOUT_MS },
              }),
            ),
          PROVIDER_PING_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    return failureFromError(title, "provider-auth", err);
  }

  return {
    id: "provider-auth",
    title,
    status: "pass",
    detail: `key works (1-token ping returned 200 OK)`,
  };
}

/**
 * Provider-specific 1-token ping. Each branch makes a single
 * non-streaming request with `max_tokens: 1` (or the provider's
 * equivalent). The response shape doesn't matter — we only care that
 * the request succeeds (key valid, network reachable, model
 * available). HTTP errors are mapped to FC-2xxx codes via
 * `mapHttpErrorToFunClaw`.
 */
async function providerPing(provider: Provider, apiKey: string, config: UserConfig): Promise<void> {
  const messages = [{ role: "user" as const, content: "ping" }];
  switch (provider) {
    case "anthropic": {
      const model = config.defaultModel ?? "claude-haiku-4-5";
      const client = new Anthropic({ apiKey });
      try {
        await client.messages.create({ model, max_tokens: 1, messages });
      } catch (err) {
        throw mapHttpErrorToFunClaw(err, provider);
      }
      return;
    }
    case "openai":
    case "openai-compatible": {
      const model = config.defaultModel ?? "gpt-4o-mini";
      const baseURL = config.endpoint;
      const client = new OpenAI({
        apiKey,
        ...(baseURL !== undefined ? { baseURL } : {}),
      });
      try {
        await client.chat.completions.create({
          model,
          max_completion_tokens: 1,
          messages,
        });
      } catch (err) {
        throw mapHttpErrorToFunClaw(err, provider);
      }
      return;
    }
    case "gemini": {
      const model = config.defaultModel ?? "gemini-2.5-flash";
      const client = new GoogleGenAI({ apiKey });
      try {
        await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          config: { maxOutputTokens: 1 },
        });
      } catch (err) {
        throw mapHttpErrorToFunClaw(err, provider);
      }
      return;
    }
  }
}

/**
 * Translate an HTTP-flavored error from any provider SDK into a
 * Fun Claw FC-2xxx error. The status field lives at slightly
 * different paths across SDKs (`.status`, `.code`, `.response.status`),
 * so we look at all the common places.
 */
function mapHttpErrorToFunClaw(err: unknown, provider: Provider): FunClawError {
  const status = extractHttpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    return funClawError({
      code: "FC-2007",
      message: `${providerLabel(provider)} rejected the API key (HTTP ${status}). Regenerate the key on the provider's console and update your environment / keyfile.`,
      data: { provider, status },
      cause: err,
    });
  }
  if (status === 429) {
    return funClawError({
      code: "FC-2004",
      message: `${providerLabel(provider)} rate-limited the doctor's ping (HTTP 429). Wait a moment and try again.`,
      data: { provider, status },
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return funClawError({
      code: "FC-2005",
      message: `${providerLabel(provider)} returned HTTP ${status}. The provider's API may be experiencing problems; check their status page.`,
      data: { provider, status },
      cause: err,
    });
  }
  // Network error or shape we don't recognize — classify as
  // unavailable (FC-2005) rather than malformed (FC-2006), since the
  // ping never received a structured response we could call
  // malformed.
  return funClawError({
    code: "FC-2005",
    message: `${providerLabel(provider)} ping failed: ${message}`,
    data: { provider },
    cause: err,
  });
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const obj = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  if (typeof obj.status === "number") return obj.status;
  if (typeof obj.statusCode === "number") return obj.statusCode;
  if (obj.response !== undefined && typeof obj.response.status === "number") {
    return obj.response.status;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Check 3 — Runtime image present
// ---------------------------------------------------------------------------

async function checkRuntimeImage(config: UserConfig | undefined): Promise<CheckResult> {
  const image = config?.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  const docker = new Docker();
  try {
    const list = await docker.listImages({ filters: { reference: [image] } });
    if (list.length > 0) {
      return {
        id: "runtime-image",
        title: "Runtime sandbox image",
        status: "pass",
        detail: `${image} present locally`,
      };
    }
    return {
      id: "runtime-image",
      title: "Runtime sandbox image",
      status: "warn",
      detail: `${image} is not present locally. Run \`funclaw doctor --pull-image\` to pull it now.`,
    };
  } catch (err) {
    return {
      id: "runtime-image",
      title: "Runtime sandbox image",
      status: "fail",
      detail: `Could not list local images: ${err instanceof Error ? err.message : String(err)}`,
      code: "FC-1001",
    };
  }
}

// ---------------------------------------------------------------------------
// Check 4 — Config parses cleanly
// ---------------------------------------------------------------------------

async function checkConfigParses(): Promise<CheckResult> {
  const path = getDefaultUserConfigPath();
  try {
    const cfg = await loadConfig();
    return {
      id: "config-parse",
      title: "Configuration",
      status: "pass",
      detail:
        `${path} parses cleanly\n` +
        `  provider: ${cfg.provider}, model: ${cfg.defaultModel ?? "(default)"}, network: ${cfg.networkMode}`,
    };
  } catch (err) {
    return failureFromError("Configuration", "config-parse", err);
  }
}

// ---------------------------------------------------------------------------
// Check 5 — Orphaned containers
// ---------------------------------------------------------------------------

async function checkOrphanedContainers(config: UserConfig | undefined): Promise<CheckResult> {
  // Need a runner to call listOrphanedSessions. Build one with the
  // configured image / workingDir if available; fall back to defaults
  // when config didn't load (so the check still runs).
  const runner = new DockerRunner({
    image: config?.runtimeImage ?? DEFAULT_RUNTIME_IMAGE,
    workingDir: config?.workingDir ?? process.cwd(),
    networkMode: config?.networkMode ?? "bridge",
  });

  let orphans: OrphanedSessionInfo[];
  try {
    orphans = await runner.listOrphanedSessions([]);
  } catch (err) {
    return {
      id: "orphaned-containers",
      title: "Orphaned containers",
      status: "fail",
      detail: `Could not list orphans: ${err instanceof Error ? err.message : String(err)}`,
      code: "FC-1001",
    };
  }

  if (orphans.length === 0) {
    return {
      id: "orphaned-containers",
      title: "Orphaned containers",
      status: "pass",
      detail: "no leftover containers from past sessions",
    };
  }

  // Group orphans by root sessionId so the user sees the structure
  // (root + its subagents indented underneath). Per Slice 9: each
  // OrphanedSessionInfo carries `subagentId?: string`; presence
  // means the entry is a subagent, absence means a root.
  const grouped = groupOrphans(orphans);
  const lines: string[] = [];
  for (const [sessionId, group] of grouped) {
    const ageStr = formatAge(Math.min(...group.map((o) => o.created)));
    lines.push(`  • root session ${sessionId.slice(0, 8)}… (oldest container: ${ageStr})`);
    const subs = group.filter((o) => o.subagentId !== undefined);
    if (subs.length > 0) {
      lines.push(`      ${subs.length} subagent container(s) under this root`);
    }
  }
  return {
    id: "orphaned-containers",
    title: "Orphaned containers",
    status: "warn",
    detail:
      `Found ${orphans.length} orphan container(s) from past sessions across ${grouped.size} root session(s):\n` +
      `${lines.join("\n")}\n` +
      "  Run `funclaw doctor --clean` to remove them.",
  };
}

function groupOrphans(orphans: readonly OrphanedSessionInfo[]): Map<string, OrphanedSessionInfo[]> {
  const map = new Map<string, OrphanedSessionInfo[]>();
  for (const o of orphans) {
    const list = map.get(o.sessionId);
    if (list === undefined) map.set(o.sessionId, [o]);
    else list.push(o);
  }
  return map;
}

function formatAge(unixSeconds: number): string {
  const ageMs = Date.now() - unixSeconds * 1000;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// --pull-image and --clean pre-flights
// ---------------------------------------------------------------------------

async function runPullImage(config: UserConfig, useColor: boolean): Promise<void> {
  const image = config.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  process.stdout.write(`${color("Pulling runtime image:", useColor, "dim")} ${image}\n`);
  const runner = new DockerRunner({
    image,
    workingDir: config.workingDir ?? process.cwd(),
    networkMode: config.networkMode ?? "bridge",
  });
  try {
    let progressCount = 0;
    await runner.ensureImage({
      onProgress: (status) => {
        progressCount += 1;
        if (progressCount % 5 === 1) {
          process.stdout.write(`  ${status.slice(0, 80)}\n`);
        }
      },
    });
    process.stdout.write(`${mark("pass", useColor)} image pull complete\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${mark("fail", useColor)} image pull failed: ${msg}\n\n`);
  }
}

async function runClean(config: UserConfig, useColor: boolean): Promise<void> {
  const runner = new DockerRunner({
    image: config.runtimeImage ?? DEFAULT_RUNTIME_IMAGE,
    workingDir: config.workingDir ?? process.cwd(),
    networkMode: config.networkMode ?? "bridge",
  });
  process.stdout.write(`${color("Cleaning orphaned containers...", useColor, "dim")}\n`);
  try {
    const orphans = await runner.listOrphanedSessions([]);
    if (orphans.length === 0) {
      process.stdout.write(`${mark("pass", useColor)} no orphans to remove\n\n`);
      return;
    }
    let removed = 0;
    let failed = 0;
    for (const o of orphans) {
      try {
        const docker = new Docker();
        await docker.getContainer(o.containerId).remove({ force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    if (failed === 0) {
      process.stdout.write(`${mark("pass", useColor)} removed ${removed} orphan container(s)\n\n`);
    } else {
      process.stdout.write(
        `${mark("warn", useColor)} removed ${removed}, failed to remove ${failed}\n\n`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${mark("fail", useColor)} cleanup failed: ${msg}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function failureFromError(title: string, id: string, err: unknown): CheckResult {
  if (isFunClawError(err)) {
    return {
      id,
      title,
      status: "fail",
      detail: err.message,
      code: err.code,
    };
  }
  return {
    id,
    title,
    status: "fail",
    detail: err instanceof Error ? err.message : String(err),
  };
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Google Gemini";
    case "openai-compatible":
      return "OpenAI-compatible endpoint";
  }
}

/** ANSI escape sequences for color output. STACK.md doesn't lock
 *  chalk; an inline four-color set is small enough to not warrant a
 *  dep. Color fires only when stdout is a TTY (so --json and CI
 *  capture stay clean). */
const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const;

function color(text: string, useColor: boolean, kind: keyof typeof ANSI): string {
  if (!useColor) return text;
  return `${ANSI[kind]}${text}${ANSI.reset}`;
}

function mark(status: CheckResult["status"], useColor: boolean): string {
  switch (status) {
    case "pass":
      return color("✓", useColor, "green");
    case "warn":
      return color("⚠", useColor, "yellow");
    case "fail":
      return color("✗", useColor, "red");
  }
}

function printCheckResultText(r: CheckResult, useColor: boolean): void {
  const codePart = r.code !== undefined ? ` ${color(`[${r.code}]`, useColor, "dim")}` : "";
  process.stdout.write(`${mark(r.status, useColor)} ${r.title}${codePart}\n`);
  for (const line of r.detail.split(/\r?\n/)) {
    process.stdout.write(`    ${line}\n`);
  }
  process.stdout.write("\n");
}

function printSummaryText(results: readonly CheckResult[], useColor: boolean): void {
  const passes = results.filter((r) => r.status === "pass").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;
  process.stdout.write(color("─".repeat(60), useColor, "dim"));
  process.stdout.write("\n");
  if (fails === 0 && warns === 0) {
    process.stdout.write(`${mark("pass", useColor)} All ${results.length} checks passed.\n`);
  } else if (fails === 0) {
    process.stdout.write(
      `${mark("warn", useColor)} ${passes} pass, ${warns} warn, ${fails} fail. Address the warnings before running \`funclaw chat\`.\n`,
    );
  } else {
    process.stdout.write(
      `${mark("fail", useColor)} ${passes} pass, ${warns} warn, ${fails} fail. Address the failures and re-run \`funclaw doctor\`.\n`,
    );
  }
}
