// Fun Claw structured logger.
//
// This is the only place in the codebase that owns log destinations and the
// secret-scrubbing policy. Every other module imports `createLogger` from
// here — never `console.*`, per the "Never `console.log` in library code"
// rule in CLAUDE.md "Key rules".
//
// Two layers of secret protection:
//   1. pino's path-based `redact` removes whole properties named after known
//      secret-bearing fields (apiKey, Authorization, env.ANTHROPIC_API_KEY,
//      etc.) with `remove: true`, so the field disappears entirely instead
//      of being replaced with the string "[REDACTED]".
//   2. A recursive value-content scrubber rewrites secret-shaped substrings
//      (Bearer tokens, sk-prefixed keys, AKIA-prefixed AWS access keys)
//      inside any string value, with a depth cap of 8 to defend against
//      accidentally circular objects.
//
// The scrubber's pattern set is locked at three. See the 2026-04-28
// "Slice 2, Q1" feedback entry in CLAUDE.md before considering changes.
//
// Reference docs:
//   - .claude/CLAUDE.md ("Never log secrets", "Error handling contract")
//   - STACK.md (Logging section: pino 9.x, pino-pretty 11.x, redact paths)
//   - REQUIREMENTS.md (Authentication: keys never logged)
//   - docs/adr/ADR-001-trust-boundaries.md (API keys never enter the
//     container; never logged; never serialized in error messages)

import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import type { Level, Logger, StreamEntry } from "pino";
import { multistream, pino } from "pino";
import pinoPretty from "pino-pretty";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * pino redact property paths. The list literally matches STACK.md "Logging"
 * with one expansion: AWS_* env vars are listed explicitly (pino's path
 * syntax does not support partial-segment globs like `AWS_*` — only
 * whole-segment `*`). The recursive value-content scrubber catches
 * AKIA-prefixed access key IDs by pattern in any string value, so this
 * list is a defense-in-depth complement, not a complete coverage by itself.
 */
const REDACT_PATHS: readonly string[] = [
  "apiKey",
  "api_key",
  "Authorization",
  "authorization",
  "token",
  "*.apiKey",
  "*.api_key",
  "*.Authorization",
  "*.authorization",
  "*.token",
  "env.ANTHROPIC_API_KEY",
  "env.OPENAI_API_KEY",
  "env.GOOGLE_API_KEY",
  "env.GITHUB_TOKEN",
  "env.AWS_ACCESS_KEY_ID",
  "env.AWS_SECRET_ACCESS_KEY",
  "env.AWS_SESSION_TOKEN",
];

/**
 * Value-content scrub patterns. Per the Slice 2 Q1 decision (locked in
 * CLAUDE.md saved feedback), exactly three patterns are applied: Bearer
 * header values, sk-prefixed keys (Anthropic / OpenAI style), and AKIA-
 * prefixed AWS access keys. Do NOT add patterns without explicit maintainer
 * approval — the small set is what avoids false positives.
 */
const SCRUB_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+\S+/g, "Bearer [REDACTED]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA[REDACTED]"],
];

/**
 * Recursion cap for the value-content scrubber. Defends against accidentally
 * circular objects without limiting any realistic log payload — 8 levels of
 * nesting is well past anything pino normally serializes.
 */
const MAX_SCRUB_DEPTH = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pino log levels exposed to callers. STACK.md defines four CLI mappings —
 * default `info`, plus `debug` / `trace` / `warn` (`--quiet`) — so the
 * exposed type matches pino's `Level` (without `"silent"`). The agent loop
 * never needs to suppress all output; structured-error paths handle that.
 */
export type LogLevel = Level;

/** Configuration for {@link createLogger}. */
export interface LoggerOptions {
  /**
   * Log level. Defaults to `"info"`. The returned logger's `.level` field
   * is mutable; the CLI reassigns it after parsing `--debug`, `--trace`,
   * or `--quiet`.
   */
  level?: LogLevel;
  /**
   * Override the JSON log file path. Pass a string to use that file, `null`
   * to disable file logging entirely (useful in tests and smoke scripts),
   * or omit to use the env-paths default
   * `<envPaths('funclaw').log>/funclaw.log`.
   */
  logFilePath?: string | null;
  /**
   * Force pretty-printed output on or off regardless of TTY detection.
   * Omitting this enables pretty output only when `process.stdout.isTTY`
   * is truthy.
   */
  pretty?: boolean;
}

/** A pino logger with Fun Claw's redaction policy applied. */
export type FunClawLogger = Logger;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a pino logger with Fun Claw's redaction policy applied.
 *
 * Default destinations:
 *   - JSON to `<envPaths('funclaw').log>/funclaw.log` (created if absent).
 *   - Pretty-printed to stdout when `process.stdout.isTTY` is truthy.
 *
 * Pass `logFilePath: null` to disable file logging (useful in smoke scripts
 * and tests). Pass `pretty: false` to force JSON output even in a TTY.
 */
export function createLogger(options: LoggerOptions = {}): FunClawLogger {
  const level: LogLevel = options.level ?? "info";
  const pretty: boolean = options.pretty ?? Boolean(process.stdout.isTTY);
  const logFilePath: string | null = resolveLogFilePath(options.logFilePath);

  const streams: StreamEntry[] = [];

  if (logFilePath !== null) {
    // env-paths picks `%LOCALAPPDATA%\funclaw-nodejs\Log` on Windows,
    // `~/Library/Logs/funclaw-nodejs/` on macOS, and
    // `$XDG_STATE_HOME/funclaw-nodejs/log/` on Linux. Verified
    // writable on Windows through Slice 6/9 chat smokes (the file
    // log captured the agent loop's events end-to-end). See
    // `docs/cross-platform.md`.
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    streams.push({
      level,
      stream: fs.createWriteStream(logFilePath, {
        flags: "a",
        encoding: "utf8",
      }),
    });
  }

  if (pretty) {
    streams.push({
      level,
      stream: pinoPretty({
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        sync: true,
      }),
    });
  }

  // Defensive fallback: if both file logging and pretty output are
  // disabled (e.g. `logFilePath: null` plus non-TTY in a test), still emit
  // JSON to stdout so log calls do not silently vanish.
  if (streams.length === 0) {
    streams.push({ level, stream: process.stdout });
  }

  return pino(
    {
      level,
      redact: {
        paths: [...REDACT_PATHS],
        remove: true,
      },
      // hooks.logMethod runs once per log call, BEFORE pino's serialization
      // — which means it sees the message string and any format args, not
      // just the merged data object. (formatters.log only sees the merged
      // object and never the msg, so it can't scrub Bearer/sk-/AKIA
      // patterns that appear inside a logged string. Discovered the hard
      // way; see CLAUDE.md saved feedback for 2026-04-28.)
      hooks: {
        logMethod(inputArgs, method) {
          const scrubbed = inputArgs.map((arg) => scrubValueContents(arg, 0)) as typeof inputArgs;
          method.apply(this, scrubbed);
        },
      },
    },
    multistream(streams),
  );
}

/**
 * Mask a secret for human-readable display. Renders the value as
 * `<first-4>...<last-4>`, e.g. a long key like `"sk-ant-…1234567890abcd"`
 * becomes `"sk-a...abcd"`.
 *
 * Used for diagnostic messages where a user needs to recognize *which* key
 * is misbehaving without exposing the full credential. Pino redaction
 * handles the structured-log side; this helper handles the formatted-string
 * side.
 *
 * Values shorter than 12 characters return `"[REDACTED]"` because the
 * first-4 + last-4 windows would overlap and reveal too much.
 */
export function maskSecret(value: string): string {
  if (value.length < 12) return "[REDACTED]";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Recursively walk a log value and rewrite secret-shaped substrings.
 * Depth-bounded at MAX_SCRUB_DEPTH (8) to defend against accidentally
 * circular graphs. Per-value cost is small for typical pino payloads;
 * the cap matters only if someone hands the logger a self-referential
 * object.
 */
function scrubValueContents(value: unknown, depth: number): unknown {
  if (depth >= MAX_SCRUB_DEPTH) return value;

  if (typeof value === "string") {
    let out = value;
    for (const [pattern, replacement] of SCRUB_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((v) => scrubValueContents(v, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValueContents(v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Resolve the JSON log file path.
 *   - `string`    → use that path
 *   - `null`      → no file logging (caller opts out)
 *   - `undefined` → env-paths default `<envPaths('funclaw').log>/funclaw.log`
 */
function resolveLogFilePath(override: string | null | undefined): string | null {
  if (override === null) return null;
  if (typeof override === "string") return override;
  const paths = envPaths("funclaw");
  return path.join(paths.log, "funclaw.log");
}
