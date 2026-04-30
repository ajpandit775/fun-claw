// Fun Claw CLI entry point.
//
// Commander 14 root. Five subcommands registered: `init`, `chat`,
// `doctor`, `skill`, and `mcp` (currently a stub pointing users at
// TOML configuration + `funclaw doctor`).
//
// Top-level concerns owned here:
//   - Pre-parse `--debug` / `--trace` / `--quiet` before commander
//     dispatch so the logger level is reconfigured before any subcommand
//     starts logging.
//   - Signal handlers for SIGINT (130) and SIGTERM (143) per the
//     CLAUDE.md error-handling contract.
//   - Top-level error handler catches `FunClawError` and other thrown
//     values, prints code+message to stderr, logs the full structured
//     error via the core logger, and exits with the right code (1 for
//     FunClawError, 2 for argument errors, 130/143 for signals).
//
// Reference docs:
//   - .claude/CLAUDE.md "Error handling contract" (exit codes; logger
//     usage; FunClawError shape).
//   - REQUIREMENTS.md Flow 1 (the funclaw init flow this slice implements
//     end-to-end).
//   - STACK.md "CLI and TUI" (commander 14, @clack/prompts 1.2 — pinned).

import { createLogger, type FunClawLogger, isFunClawError, type LogLevel } from "@funclaw/core";
import { Command, InvalidArgumentError } from "commander";
import { registerChat } from "./commands/chat.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerInit } from "./commands/init.js";
import { registerMcp } from "./commands/mcp.js";
import { registerSkill } from "./commands/skill.js";

// CLI version is sourced from the package.json next to dist/. tsup leaves
// the package.json adjacent on install; the bin runs from dist/.
// We read it lazily so the import has no runtime cost.
function readCliVersion(): string {
  try {
    // require() is fine here — packages/cli is "type": "commonjs" and the
    // build emits CJS. This avoids an import-attribute dance for JSON.
    // eslint-disable-next-line -- biome doesn't ship a no-require rule
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Pre-parse global log-level flags from `process.argv` before commander
 * dispatch. The flags are also registered on the root command so
 * `--help` lists them; this pass just lets us configure the logger
 * level before any subcommand runs.
 */
function preParseLogLevel(argv: readonly string[]): LogLevel {
  if (argv.includes("--trace")) return "trace";
  if (argv.includes("--debug")) return "debug";
  if (argv.includes("--quiet")) return "warn";
  return "info";
}

/**
 * Print a FunClawError to stderr in the contract format and log the full
 * structured error to the log file. The CLI tone is warm but the error
 * surface is direct — no smiley, no "oops!" — so users can grep for
 * codes. Multi-line messages indent continuation lines for readability.
 */
function reportError(err: unknown, logger: FunClawLogger): void {
  if (isFunClawError(err)) {
    process.stderr.write(`funclaw: [${err.code}] ${err.message}\n`);
    logger.error({ code: err.code, data: err.data, cause: err.cause }, err.message);
    return;
  }
  // Unknown throw — best-effort message, full record goes to log.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`funclaw: ${message}\n`);
  logger.error({ err }, "unhandled error");
}

async function main(): Promise<void> {
  const level = preParseLogLevel(process.argv);
  const logger = createLogger({ level });

  // SIGTERM does not fire on Windows native processes the same way
  // it does on POSIX (Node converts most kill signals to plain
  // process termination on Windows). SIGINT (Ctrl-C) works on both
  // platforms — that's the canonical "user wants to stop the chat"
  // path the TUI's double-tap policy depends on. Windows users who
  // need a hard kill use Task Manager. See `docs/cross-platform.md`.
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "received signal, shutting down");
    process.stderr.write(`\nfunclaw: caught ${sig}, shutting down.\n`);
    process.exit(exitCode);
  };
  process.on("SIGINT", () => {
    onSignal("SIGINT", 130);
  });
  process.on("SIGTERM", () => {
    onSignal("SIGTERM", 143);
  });

  const program = new Command();
  program
    .name("funclaw")
    .description("Fun Claw — a friendly autonomous AI agent that lives in your terminal.")
    .version(readCliVersion(), "-v, --version", "print the funclaw version")
    .option("--debug", "log at debug level")
    .option("--trace", "log at trace level (very chatty)")
    .option("--quiet", "log at warn level only")
    .showHelpAfterError("(run `funclaw --help` for usage)");

  // Subcommand registration. Each command file owns its own commander
  // setup so the entry stays small and the help output is shaped by the
  // commands themselves.
  registerInit(program, logger);
  registerChat(program, logger);
  registerDoctor(program);
  registerSkill(program);
  registerMcp(program);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof InvalidArgumentError) {
      process.stderr.write(`funclaw: ${err.message}\n`);
      process.exit(2);
    }
    reportError(err, logger);
    process.exit(1);
  }
}

void main();
