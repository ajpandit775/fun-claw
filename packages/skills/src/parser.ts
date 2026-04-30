// Fun Claw skill parser.
//
// Reads a `SKILL.md` file from disk, splits the YAML frontmatter from
// the markdown body, validates the frontmatter against a Zod schema,
// and verifies the frontmatter `name` matches the parent directory
// name. Pure parser — never executes, transforms, or interprets the
// markdown body. Per ADR-001's host-trust rule: "the host loader is a
// pure parser ... the host never `eval`s, `Function`-constructs, or
// template-expands skill bodies."
//
// Frontmatter format (agentskills.io / OpenClaw compatible):
//
//   ---
//   name: my-skill
//   description: One-line summary up to 200 chars.
//   version: 1.0.0      # optional; defaults to "0.0.0"
//   author: Alice       # optional
//   license: Apache-2.0 # optional
//   # additional fields preserved (forward compat) but ignored
//   ---
//   <markdown body>
//
// Frontmatter delimiter: a line containing exactly `---` (with
// optional surrounding whitespace). The first such line opens the
// frontmatter; the next closes it. Both `\n` and `\r\n` line endings
// accepted (CLAUDE.md cross-platform rule: never assume `\n`).
//
// The `yaml` package (eemeli/yaml ^2) is the locked YAML parser per
// STACK.md — js-yaml is forbidden (legacy, billion-laughs vulnerable
// in default config).
//
// Reference docs:
//   - .claude/CLAUDE.md "Key rules" (cross-platform line endings).
//   - STACK.md "HTTP, streaming, schemas" (yaml ^2 with maxAliasCount
//     100 and core schema; js-yaml forbidden).
//   - REQUIREMENTS.md "Hard constraints" (agentskills.io format).
//   - docs/adr/ADR-001-trust-boundaries.md (host loader is a pure
//     parser).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  frontmatterSchemaError,
  frontmatterYamlError,
  nameMismatchError,
  scriptsDirectoryUnreadableError,
  skillMdMissingError,
  skillNameForbiddenError,
} from "./errors.js";
import type { Skill, SkillFrontmatter } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Locked skill-name regex. Matches the FC-4007 helper's documented
 * rule: lowercase letters, digits, dash, underscore, leading letter,
 * 1–64 chars.
 *
 * Rationale (from Slice 8 kickoff):
 *   - Lowercase only — prevents Windows-vs-POSIX case sensitivity
 *     ambiguity (Windows treats `Foo` and `foo` as the same path).
 *   - Leading letter — keeps `skill__<name>` tool naming clean for
 *     LLM consumption.
 *   - No `/`, `\`, `..`, null, or whitespace — path-traversal and
 *     mount-target safety.
 *   - 64-char cap — keeps `skill__<name>` tool names short enough
 *     for provider tools-list dumps to remain readable.
 */
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const DESCRIPTION_MAX_LEN = 200;
const SCRIPTS_SUBDIR = "scripts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for SKILL.md frontmatter. `.passthrough()` retains
 * unknown fields per the Slice 8 forward-compat decision —
 * agentskills.io may grow new optional fields and we want existing
 * skills to keep loading. The fields below are the v1 contract.
 *
 * `version` defaults to `"0.0.0"` rather than being optional so the
 * downstream `Skill.frontmatter.version` field is non-nullable.
 */
export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(DESCRIPTION_MAX_LEN),
    version: z.string().min(1).default("0.0.0"),
    author: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/**
 * Parse a `SKILL.md` file from disk. The argument is the path TO THE
 * SKILL.MD FILE itself, not to the parent directory.
 *
 * Throws (per the FC-4xxx error contract):
 *   - FC-4001 — SKILL.md not found at the given path.
 *   - FC-4002 — frontmatter YAML parse failure.
 *   - FC-4003 — frontmatter schema validation failure.
 *   - FC-4004 — frontmatter `name` doesn't match parent directory.
 *   - FC-4007 — frontmatter `name` violates the skill-name regex.
 *
 * FC-4006 (scripts directory unreadable) is best-effort: if we can
 * `fs.statSync` the scripts directory but can't `readdirSync` it,
 * we still return the parsed skill but log the situation by leaving
 * `scriptsDirectory` undefined — actual readability is asserted at
 * mount time by the runner's policy validator.
 */
export async function parseSkillMd(skillMdPath: string): Promise<Skill> {
  // (FC-4001) File presence.
  let raw: string;
  try {
    raw = await fs.promises.readFile(skillMdPath, "utf8");
  } catch (cause) {
    if (isFileNotFound(cause)) {
      throw skillMdMissingError({
        skillDirectory: path.dirname(skillMdPath),
        expectedPath: skillMdPath,
      });
    }
    // Other read errors — re-throw as YAML error since we can't
    // distinguish "file unreadable" from "directory unreadable" from
    // "ENOTDIR" without more probing. The cause carries detail.
    throw frontmatterYamlError({ skillMdPath, cause });
  }

  // Split frontmatter from body. Per the kickoff format, frontmatter
  // is bounded by `---` lines.
  const split = splitFrontmatter(raw);
  if (split === null) {
    throw frontmatterYamlError({
      skillMdPath,
      cause: new Error("no YAML frontmatter delimiters (`---`) found at the top of the file"),
    });
  }
  const { frontmatterText, body } = split;

  // (FC-4002) Parse YAML.
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(frontmatterText, {
      // Match STACK.md's locked YAML config: core schema (rejects
      // YAML 1.1 No/Yes booleans), maxAliasCount: 100 (no raise).
      schema: "core",
      maxAliasCount: 100,
    });
  } catch (cause) {
    throw frontmatterYamlError({ skillMdPath, cause });
  }
  if (parsedYaml === null || typeof parsedYaml !== "object" || Array.isArray(parsedYaml)) {
    throw frontmatterYamlError({
      skillMdPath,
      cause: new Error("frontmatter is not a YAML mapping (must be `key: value` pairs)"),
    });
  }

  // (FC-4003) Validate against the schema.
  const result = SkillFrontmatterSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw frontmatterSchemaError({
      skillMdPath,
      detail: formatZodIssues(result.error),
      cause: result.error,
    });
  }
  // The .passthrough() preserves extra fields on result.data; we
  // narrow to the v1 contract (the SkillFrontmatter interface) below.
  const fm = result.data;

  // (FC-4007) Skill name regex — applied AFTER schema parse so the
  // FC-4003 path catches "missing name" / "name not a string" cases.
  if (!SKILL_NAME_RE.test(fm.name)) {
    throw skillNameForbiddenError({
      proposedName: fm.name,
      detail: "name does not match the locked /^[a-z][a-z0-9_-]{0,63}$/ pattern",
    });
  }

  // (FC-4004) Name must match parent directory name.
  const directory = path.dirname(skillMdPath);
  const directoryName = path.basename(directory);
  if (fm.name !== directoryName) {
    throw nameMismatchError({
      skillMdPath,
      frontmatterName: fm.name,
      directoryName,
    });
  }

  // Optional scripts directory probe. Best-effort: stat to detect
  // existence; readdir to detect readability. Failures yield FC-4006
  // wrapped, but we surface as `scriptsDirectory: undefined` rather
  // than throwing — the skill body still loads.
  const scriptsDir = path.join(directory, SCRIPTS_SUBDIR);
  let scriptsDirectory: string | undefined;
  try {
    const st = await fs.promises.stat(scriptsDir);
    if (st.isDirectory()) {
      // Probe readability by listing once. We don't actually need the
      // entries here; we just need to know the runner will be able to
      // mount it. If readdir fails, leave scriptsDirectory undefined.
      try {
        await fs.promises.readdir(scriptsDir);
        scriptsDirectory = scriptsDir;
      } catch (cause) {
        // FC-4006 surfaces as a thrown error to give the caller a
        // chance to log it; consumers (discovery.ts) catch it and
        // continue with `scriptsDirectory: undefined`.
        throw scriptsDirectoryUnreadableError({
          skillName: fm.name,
          scriptsDirectory: scriptsDir,
          cause,
        });
      }
    }
  } catch (e) {
    // Re-throw FC-4006; ignore "doesn't exist" stat errors.
    if (
      e !== null &&
      typeof e === "object" &&
      typeof (e as { code?: unknown }).code === "string" &&
      (e as { code: string }).code === "FC-4006"
    ) {
      throw e;
    }
    // ENOENT / other stat errors — scripts dir simply doesn't exist.
    scriptsDirectory = undefined;
  }

  const frontmatter: SkillFrontmatter = {
    name: fm.name,
    description: fm.description,
    version: fm.version,
    ...(fm.author !== undefined ? { author: fm.author } : {}),
    ...(fm.license !== undefined ? { license: fm.license } : {}),
  };

  return {
    frontmatter,
    body,
    skillMdPath,
    directory,
    ...(scriptsDirectory !== undefined ? { scriptsDirectory } : {}),
  };
}

/**
 * Convenience: validate a frontmatter object directly (without a file
 * read). Returns the validated frontmatter or throws the same FC-4xxx
 * codes as `parseSkillMd`. Used by `funclaw skill validate` when the
 * caller already has the YAML in hand.
 *
 * @internal — exported for tests + the validate subcommand.
 */
export function validateFrontmatter(parsedYaml: unknown, skillMdPath: string): SkillFrontmatter {
  const result = SkillFrontmatterSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw frontmatterSchemaError({
      skillMdPath,
      detail: formatZodIssues(result.error),
      cause: result.error,
    });
  }
  if (!SKILL_NAME_RE.test(result.data.name)) {
    throw skillNameForbiddenError({
      proposedName: result.data.name,
      detail: "name does not match the locked /^[a-z][a-z0-9_-]{0,63}$/ pattern",
    });
  }
  return {
    name: result.data.name,
    description: result.data.description,
    version: result.data.version,
    ...(result.data.author !== undefined ? { author: result.data.author } : {}),
    ...(result.data.license !== undefined ? { license: result.data.license } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Split a raw SKILL.md text into frontmatter text + body text. Returns
 * null if the file has no `---`-bounded frontmatter.
 *
 * Frontmatter delimiter rule: a line whose ONLY content (ignoring
 * surrounding whitespace) is `---`. The first opens, the next closes.
 * Cross-platform line endings supported via `\r?\n` splitting.
 */
function splitFrontmatter(raw: string): { frontmatterText: string; body: string } | null {
  // Normalize CRLF → LF for split/scan purposes; we preserve original
  // line endings in the body via slicing the original buffer below.
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return null;

  const frontmatterText = lines.slice(1, endIndex).join("\n");
  // Body starts on the line AFTER the closing `---`. Preserve content
  // by joining with `\n` — we don't bother round-tripping CRLF because
  // the body is opaque text and the agent loop only reads it.
  const body = lines.slice(endIndex + 1).join("\n");
  return { frontmatterText, body };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

function isFileNotFound(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}
