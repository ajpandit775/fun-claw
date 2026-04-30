// Public types for `@funclaw/skills`.
//
// A "skill" in Fun Claw follows the agentskills.io / OpenClaw format
// (per REQUIREMENTS.md "Hard constraints"): a directory whose name
// matches a `name` field in YAML frontmatter at the top of a
// `SKILL.md` file, optionally containing a `scripts/` subdirectory of
// helper scripts.
//
// Reference docs:
//   - .claude/CLAUDE.md (skill pre-decisions: instruction-module
//     pattern, three-source discovery precedence).
//   - REQUIREMENTS.md Flow 3 (skill use), Flow 7 (agent authors
//     skill via write_file), Flow 8 (third-party agentskills.io
//     compatibility).
//   - docs/adr/ADR-001-trust-boundaries.md ("Skills are loaded by a
//     pure parser on the host. The host never executes skill
//     content.").

/**
 * The three discovery sources, in precedence order. Later sources
 * override earlier ones — a skill named "git-helper" in the project
 * directory shadows a same-named skill in the user directory or the
 * bundled set.
 *
 * Source labels surface in `funclaw skill list` output and in the
 * system prompt so the agent (and a user reading logs) can tell where
 * a skill came from.
 */
export type SkillSource = "bundled" | "user" | "project";

/**
 * Validated frontmatter shape. The Zod schema in `parser.ts` is the
 * source of truth for runtime validation; this interface mirrors the
 * `z.infer` output so consumers can type-narrow without importing the
 * schema.
 */
export interface SkillFrontmatter {
  /** Skill name. Must match the directory name. Lowercase alnum +
   *  dash + underscore, 1–64 chars, leading lowercase letter. */
  name: string;
  /** One-line description (≤200 chars). Surfaced in the system prompt
   *  index and in `funclaw skill list`. */
  description: string;
  /** Optional semver string. Defaults to `"0.0.0"` when missing. */
  version: string;
  /** Optional author string. */
  author?: string;
  /** Optional license string (SPDX identifier or arbitrary text). */
  license?: string;
}

/**
 * A parsed skill: validated frontmatter + opaque markdown body. The
 * agent loop's `skill__<name>` tool handler returns the body verbatim
 * — Fun Claw never executes, transforms, or interprets the body
 * content (per ADR-001's "the host loader is a pure parser" rule).
 */
export interface Skill {
  /** Validated frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body, verbatim, with the frontmatter delimiters
   *  stripped. */
  body: string;
  /** Absolute path to the skill's SKILL.md file. */
  skillMdPath: string;
  /** Absolute path to the skill's directory. */
  directory: string;
  /** Absolute path to the skill's `scripts/` directory if present
   *  on disk, else undefined. The chat command bind-mounts the
   *  scripts directory into the container at `/skills/<name>/scripts`
   *  so the agent can invoke them via `execute_bash`. */
  scriptsDirectory?: string;
}

/**
 * A skill plus its discovery source. Returned from `discoverSkills`
 * after precedence resolution. The system prompt builder consumes
 * these to label skills in the "## Skills available" section.
 */
export interface DiscoveredSkill {
  skill: Skill;
  source: SkillSource;
}
