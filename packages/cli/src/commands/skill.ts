// `funclaw skill` — local skill discovery, inspection, and validation.
//
// Three subcommands:
//
//   - `funclaw skill list` — discovers skills across the three
//     resolution sources (bundled / user / project) and prints a
//     compact table: name, version, source, description.
//
//   - `funclaw skill show <name>` — locates a single skill (project
//     overrides user overrides bundled, same precedence as the chat
//     session) and prints its frontmatter + markdown body.
//
//   - `funclaw skill validate <path>` — points at an arbitrary
//     SKILL.md file (NOT a directory) and reports whether it parses.
//     Useful for skill authors checking a file before placing it in
//     the user / project skills directory. Distinct from list/show
//     because the file may not yet be in any discovery source.
//
// No skill creation or editing — that's the agent's job (Flow 7 in
// REQUIREMENTS.md) via the `write_file` tool. The subcommand is
// read-only inspection.
//
// Reference docs:
//   - .claude/CLAUDE.md (skill subcommand pre-decisions: list / show
//     / validate; no creation/editing).
//   - REQUIREMENTS.md Flow 3 / Flow 7 / Flow 8.

import { isFunClawError } from "@funclaw/core";
import { discoverSkills, parseSkillMd, type Skill } from "@funclaw/skills";
import type { Command } from "commander";

export function registerSkill(program: Command): void {
  const skill = program
    .command("skill")
    .description("list, validate, and inspect agentskills.io-format skills");

  skill
    .command("list")
    .description("list discoverable skills across the resolution paths")
    .action(async () => {
      await runSkillList();
    });

  skill
    .command("show <name>")
    .description("print a skill's frontmatter and markdown body")
    .action(async (name: string) => {
      await runSkillShow(name);
    });

  skill
    .command("validate <path>")
    .description("parse a SKILL.md file and report any issues")
    .action(async (filePath: string) => {
      await runSkillValidate(filePath);
    });

  // No default action — `funclaw skill` (no subcommand) prints help.
}

async function runSkillList(): Promise<void> {
  const skills = await discoverSkills();

  if (skills.length === 0) {
    process.stdout.write(
      "No skills found in any source.\n" +
        "  - Bundled: shipped with Fun Claw (currently empty).\n" +
        "  - User: <env-paths data dir>/funclaw-nodejs/Data/skills/\n" +
        "  - Project: ./.funclaw/skills/\n" +
        "\n" +
        "Ask Fun Claw to write a skill for you (`funclaw chat`, then describe what " +
        "you want), or drop an agentskills.io-format skill directory into one of " +
        "the paths above.\n",
    );
    return;
  }

  // Compute column widths for a tidy aligned table without dragging
  // in cli-table-style deps.
  const nameW = Math.max(4, ...skills.map((s) => s.skill.frontmatter.name.length));
  const verW = Math.max(7, ...skills.map((s) => s.skill.frontmatter.version.length));
  const srcW = Math.max(6, ...skills.map((s) => s.source.length));

  const header = `${pad("NAME", nameW)}  ${pad("VERSION", verW)}  ${pad("SOURCE", srcW)}  DESCRIPTION`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${"-".repeat(header.length)}\n`);
  for (const ds of skills) {
    const fm = ds.skill.frontmatter;
    process.stdout.write(
      `${pad(fm.name, nameW)}  ${pad(fm.version, verW)}  ${pad(ds.source, srcW)}  ${fm.description}\n`,
    );
  }
}

async function runSkillShow(name: string): Promise<void> {
  const skills = await discoverSkills();
  const found = skills.find((s) => s.skill.frontmatter.name === name);
  if (found === undefined) {
    process.stderr.write(
      `funclaw: no skill named "${name}" found in any source.\n` +
        "Run `funclaw skill list` to see what's available.\n",
    );
    process.exit(1);
  }
  printSkill(found.skill, found.source);
}

async function runSkillValidate(filePath: string): Promise<void> {
  try {
    const skill = await parseSkillMd(filePath);
    process.stdout.write(
      `OK: ${filePath}\n` +
        `  name:        ${skill.frontmatter.name}\n` +
        `  description: ${skill.frontmatter.description}\n` +
        `  version:     ${skill.frontmatter.version}\n` +
        (skill.frontmatter.author !== undefined
          ? `  author:      ${skill.frontmatter.author}\n`
          : "") +
        (skill.frontmatter.license !== undefined
          ? `  license:     ${skill.frontmatter.license}\n`
          : "") +
        (skill.scriptsDirectory !== undefined
          ? `  scripts:     ${skill.scriptsDirectory}\n`
          : "  scripts:     (none)\n") +
        `\nbody preview (first 200 chars):\n${skill.body.slice(0, 200)}` +
        (skill.body.length > 200 ? "\n[...truncated]" : ""),
    );
    process.stdout.write("\n");
  } catch (err) {
    if (isFunClawError(err)) {
      process.stderr.write(`funclaw: [${err.code}] ${err.message}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`funclaw: validation failed: ${msg}\n`);
    }
    process.exit(1);
  }
}

function printSkill(skill: Skill, source: string): void {
  const fm = skill.frontmatter;
  process.stdout.write(
    `# ${fm.name}\n` +
      `version: ${fm.version}\n` +
      `source:  ${source} (${skill.directory})\n` +
      `description: ${fm.description}\n`,
  );
  if (fm.author !== undefined) process.stdout.write(`author:  ${fm.author}\n`);
  if (fm.license !== undefined) process.stdout.write(`license: ${fm.license}\n`);
  if (skill.scriptsDirectory !== undefined) {
    process.stdout.write(`scripts: ${skill.scriptsDirectory}\n`);
  }
  process.stdout.write(`\n--- body ---\n${skill.body}\n`);
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
