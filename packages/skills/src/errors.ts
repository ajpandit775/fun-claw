// FC-4xxx error helpers for `@funclaw/skills`.
//
// Per CLAUDE.md "Error handling contract", every shipped FC code needs
// a `docs/troubleshooting.md` entry before slice close. The helpers
// below are the canonical construction sites — search for these names
// to know exactly which FC-4xxx codes are live in the codebase.
//
// Note: FC-4005 (skill name conflict) is reserved by the Slice 8
// kickoff but unused in source — discovery precedence resolves
// same-named skills to the highest source rather than throwing. The
// code stays reserved so future changes that genuinely surface a
// conflict (e.g., two skills with different storage paths but the
// same resolved name in the same source) can claim it without
// renumbering.
//
// Reference docs:
//   - .claude/CLAUDE.md "Saved feedback" — Slice 3 narrow-specificity
//     pattern carries over to FC-4xxx.

import { type FunClawError, funClawError } from "@funclaw/core";

// All helpers return `Error & FunClawError` to match the runtime
// shape `funClawError` constructs (a real Error with FunClawError
// fields attached). Mirrors the FC-3xxx pattern in mcp-client/errors.
type FCError = Error & FunClawError;

/**
 * FC-4001 — SKILL.md not found in skill directory. The directory
 * exists (we walked into it) but the required `SKILL.md` file is
 * missing.
 */
export function skillMdMissingError(args: {
  skillDirectory: string;
  expectedPath: string;
}): FCError {
  return funClawError({
    code: "FC-4001",
    message:
      `Skill directory "${args.skillDirectory}" is missing SKILL.md. ` +
      "Every skill needs a SKILL.md with YAML frontmatter (name, description) and a markdown body.",
    data: { skillDirectory: args.skillDirectory, expectedPath: args.expectedPath },
  });
}

/**
 * FC-4002 — SKILL.md frontmatter is not valid YAML. Either the
 * `---` markers are malformed, the YAML between them has a parse
 * error, or there is no frontmatter at all (we require frontmatter).
 */
export function frontmatterYamlError(args: { skillMdPath: string; cause: unknown }): FCError {
  return funClawError({
    code: "FC-4002",
    message:
      `SKILL.md at ${args.skillMdPath} has invalid YAML frontmatter. ` +
      "Frontmatter must be a YAML object between two `---` lines at the top of the file.",
    cause: args.cause,
    data: { skillMdPath: args.skillMdPath },
  });
}

/**
 * FC-4003 — Frontmatter parsed as YAML but failed Zod schema
 * validation (missing `name` / `description`, wrong types, name out
 * of allowed character set, etc.).
 */
export function frontmatterSchemaError(args: {
  skillMdPath: string;
  detail: string;
  cause: unknown;
}): FCError {
  return funClawError({
    code: "FC-4003",
    message:
      `SKILL.md at ${args.skillMdPath} frontmatter failed schema validation: ${args.detail}. ` +
      "Required fields: name (string, lowercase alnum + dash + underscore, 1–64 chars), description (string, ≤200 chars).",
    cause: args.cause,
    data: { skillMdPath: args.skillMdPath },
  });
}

/**
 * FC-4004 — `frontmatter.name` doesn't match the parent directory
 * name. The agentskills.io spec requires these to agree so a skill's
 * disk location and the LLM-visible tool name (`skill__<name>`) stay
 * in sync.
 */
export function nameMismatchError(args: {
  skillMdPath: string;
  frontmatterName: string;
  directoryName: string;
}): FCError {
  return funClawError({
    code: "FC-4004",
    message:
      `SKILL.md at ${args.skillMdPath} frontmatter name "${args.frontmatterName}" ` +
      `doesn't match its directory name "${args.directoryName}". ` +
      "Rename the directory or the frontmatter so they agree.",
    data: {
      skillMdPath: args.skillMdPath,
      frontmatterName: args.frontmatterName,
      directoryName: args.directoryName,
    },
  });
}

/**
 * FC-4005 — Skill name conflict. RESERVED by Slice 8 but unused —
 * discovery precedence (project > user > bundled) resolves same-named
 * skills automatically rather than throwing. Kept reserved so future
 * conflicting-skill scenarios have a code without renumbering.
 *
 * @internal Construction site exposed only for tests / future use.
 */
export function skillNameConflictError(args: { skillName: string; detail: string }): FCError {
  return funClawError({
    code: "FC-4005",
    message: `Skill name conflict for "${args.skillName}": ${args.detail}.`,
    data: { skillName: args.skillName, detail: args.detail },
  });
}

/**
 * FC-4006 — Skill `scripts/` directory exists but is not readable
 * (permissions, broken symlink, etc.). The skill itself loads — the
 * markdown body is fine — but its scripts won't be reachable inside
 * the container.
 */
export function scriptsDirectoryUnreadableError(args: {
  skillName: string;
  scriptsDirectory: string;
  cause: unknown;
}): FCError {
  return funClawError({
    code: "FC-4006",
    message:
      `Skill "${args.skillName}" scripts directory at ${args.scriptsDirectory} ` +
      `is not readable. The skill's body still loads, but its scripts won't be available inside the sandbox.`,
    cause: args.cause,
    data: { skillName: args.skillName, scriptsDirectory: args.scriptsDirectory },
  });
}

/**
 * FC-4007 — Skill name contains characters outside the allowed set.
 * The locked skill-name regex is `/^[a-z][a-z0-9_-]{0,63}$/`:
 * lowercase letter or digit or dash or underscore, leading letter,
 * 1–64 chars. This rules out path-traversal (`..`, `/`), Windows
 * drive letters, null bytes, and any character that would corrupt
 * the `skill__<name>` tool naming or the `/skills/<name>` mount
 * target.
 */
export function skillNameForbiddenError(args: { proposedName: string; detail: string }): FCError {
  return funClawError({
    code: "FC-4007",
    message:
      `Skill name "${args.proposedName}" is rejected: ${args.detail}. ` +
      "Allowed: lowercase letters, digits, dash, underscore. Must start with a letter. 1–64 chars.",
    data: { proposedName: args.proposedName, detail: args.detail },
  });
}
