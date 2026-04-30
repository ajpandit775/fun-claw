// Fun Claw skill discovery.
//
// Walks the three discovery sources (bundled, user, project) in
// precedence order — later sources override earlier ones — and
// returns the resolved set of skills. Failed skills are logged but
// don't break discovery: one bad SKILL.md in the user directory
// shouldn't cause the chat session to fail to start. This mirrors
// the MCP server failure pattern from Slice 7.
//
// Source paths:
//   - bundled — `<package-root>/bundled/` (relative to this module's
//     dist location at runtime; ships zero skills in v1, here for
//     forward compatibility).
//   - user — `<envPaths('funclaw').data>/skills/` (env-paths data
//     dir, OS-correct).
//   - project — `<cwd>/.funclaw/skills/` (per the kickoff —
//     project-local skills checked into the user's repo).
//
// Reference docs:
//   - .claude/CLAUDE.md (Slice 8 pre-decisions: precedence order
//     bundled < user < project).
//   - REQUIREMENTS.md Flow 8 (third-party skills from agentskills.io
//     dropped into the user directory).

import * as fs from "node:fs";
import * as path from "node:path";
import { type FunClawError, type FunClawLogger, isFunClawError } from "@funclaw/core";
import envPaths from "env-paths";
import { parseSkillMd } from "./parser.js";
import type { DiscoveredSkill, SkillSource } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoverSkillsOptions {
  /** Working directory used to anchor the project source. Defaults to
   *  `process.cwd()`. */
  cwd?: string;
  /** Override the bundled source path. Defaults to the package's
   *  `bundled/` directory adjacent to the compiled `dist/`. */
  bundledDir?: string;
  /** Override the user source path. Defaults to env-paths' data dir
   *  + `/skills`. */
  userDir?: string;
  /** Override the project source path. Defaults to
   *  `<cwd>/.funclaw/skills`. */
  projectDir?: string;
  /** Optional logger for warning on failed-skill cases. */
  logger?: FunClawLogger;
}

/**
 * Discover all loadable skills across the three sources, applying
 * precedence (bundled < user < project — later wins). Returns the
 * resolved skill set tagged with each skill's winning source.
 *
 * Discovery is best-effort: skills whose SKILL.md fails to parse are
 * logged as warnings (with the FC-4xxx code) and skipped. The caller
 * gets back only the skills that loaded cleanly.
 */
export async function discoverSkills(
  options: DiscoverSkillsOptions = {},
): Promise<DiscoveredSkill[]> {
  const cwd = options.cwd ?? process.cwd();

  // Resolve the three source paths.
  const bundledDir = options.bundledDir ?? defaultBundledDir();
  const userDir = options.userDir ?? defaultUserSkillsDir();
  const projectDir = options.projectDir ?? path.join(cwd, ".funclaw", "skills");

  // Walk each source. Order matters: later entries override earlier
  // ones in the resolved Map.
  const resolved = new Map<string, DiscoveredSkill>();

  for (const [dir, source] of [
    [bundledDir, "bundled" as const],
    [userDir, "user" as const],
    [projectDir, "project" as const],
  ] as const) {
    const skills = await discoverInDir(dir, source, options.logger);
    for (const ds of skills) {
      resolved.set(ds.skill.frontmatter.name, ds);
    }
  }

  // Stable order for deterministic system-prompt output.
  return Array.from(resolved.values()).sort((a, b) =>
    a.skill.frontmatter.name.localeCompare(b.skill.frontmatter.name),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function discoverInDir(
  dir: string,
  source: SkillSource,
  logger: FunClawLogger | undefined,
): Promise<DiscoveredSkill[]> {
  // Source directory may not exist (no project-local skills, no
  // bundled skills, etc.). That's not an error.
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (isDirNotFound(cause)) return [];
    logger?.warn(
      { dir, source, cause },
      `Skill source "${source}" at ${dir} could not be listed; skipping.`,
    );
    return [];
  }

  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    try {
      const skill = await parseSkillMd(skillMdPath);
      out.push({ skill, source });
    } catch (err) {
      logSkillFailure(logger, source, skillDir, err);
    }
  }
  return out;
}

function logSkillFailure(
  logger: FunClawLogger | undefined,
  source: SkillSource,
  skillDir: string,
  err: unknown,
): void {
  if (logger === undefined) return;
  if (isFunClawError(err)) {
    const fcErr: FunClawError = err;
    logger.warn(
      { source, skillDir, code: fcErr.code, err: fcErr },
      `[${fcErr.code}] Skill at ${skillDir} failed to load: ${fcErr.message}`,
    );
    return;
  }
  logger.warn(
    { source, skillDir, err },
    `Skill at ${skillDir} failed to load with an unexpected error.`,
  );
}

/**
 * Default bundled-skills directory. Resolved relative to this module's
 * compiled file path so it works whether running from `dist/` or
 * dynamically loaded via the package's main entry.
 *
 * At runtime, `__dirname` for the compiled `discovery.js` is
 * `packages/skills/dist/`, and `bundled/` lives at
 * `packages/skills/bundled/`. The relative resolution `../bundled`
 * lands there.
 */
function defaultBundledDir(): string {
  // Resolve from the compiled location. Per the saved feedback rule
  // about NodeNext + `.js` extensions on relative imports: this is
  // a runtime path computation, not an import, so the rule doesn't
  // apply here.
  return path.resolve(__dirname, "..", "bundled");
}

/**
 * Default user-skills directory: `<envPaths('funclaw').data>/skills`.
 * This intentionally uses env-paths' data dir (e.g. `~/.local/share/`
 * on Linux, `~/Library/Application Support/funclaw-nodejs/Data/` on
 * macOS, `%LOCALAPPDATA%\funclaw-nodejs\Data\` on Windows) rather than
 * the keyfile's `~/.funclaw/keys.json` location — the keyfile is a
 * single dotfile by spec; skills are an OS-correct data tree.
 */
function defaultUserSkillsDir(): string {
  // env-paths picks `%LOCALAPPDATA%\funclaw-nodejs\Data\skills` on
  // Windows, `~/Library/Application Support/funclaw-nodejs/Data/skills`
  // on macOS, `$XDG_DATA_HOME/funclaw-nodejs/skills` on Linux.
  // Discovery verified on Windows through Slice 8 Task 3 manual
  // smoke (`funclaw skill list` found the test fixture under that
  // exact path). See `docs/cross-platform.md`.
  const paths = envPaths("funclaw");
  return path.join(paths.data, "skills");
}

function isDirNotFound(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
