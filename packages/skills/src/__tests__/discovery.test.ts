// Vitest tests for `discoverSkills` precedence rules.
//
// Discovery walks three sources in order: bundled < user < project.
// Same-named skills resolve to the highest source, so a `git-helper`
// in all three resolves to the `project` version. Tests use temp
// directories to exercise the precedence behavior end-to-end.
//
// Failed-skill resilience is also covered: a malformed SKILL.md in
// one source must not break discovery for the other two.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../discovery.js";

let tmpRoot: string;
let bundledDir: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-discovery-test-"));
  bundledDir = path.join(tmpRoot, "bundled");
  userDir = path.join(tmpRoot, "user");
  projectDir = path.join(tmpRoot, "project");
  // Each source dir must exist for the walker to inspect it; the
  // walker treats ENOENT as "no skills here, move on" — but we want
  // explicit per-test control over what's where.
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkillIn(parentDir: string, skillName: string, version: string): void {
  const dir = path.join(parentDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---
name: ${skillName}
description: ${parentDir} version of ${skillName}.
version: ${version}
---

Body for ${skillName} from ${path.basename(parentDir)}.
`,
    "utf8",
  );
}

describe("discoverSkills — basic walk", () => {
  it("returns no skills when all three sources are empty", async () => {
    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills).toStrictEqual([]);
  });

  it("walks all three sources independently and merges their skills", async () => {
    writeSkillIn(bundledDir, "alpha", "1.0.0");
    writeSkillIn(userDir, "beta", "2.0.0");
    writeSkillIn(projectDir, "gamma", "3.0.0");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    const summary = skills.map((s) => ({
      name: s.skill.frontmatter.name,
      source: s.source,
      version: s.skill.frontmatter.version,
    }));
    // Discovery sorts alphabetically.
    expect(summary).toStrictEqual([
      { name: "alpha", source: "bundled", version: "1.0.0" },
      { name: "beta", source: "user", version: "2.0.0" },
      { name: "gamma", source: "project", version: "3.0.0" },
    ]);
  });

  it("skips files that aren't directories", async () => {
    fs.writeFileSync(path.join(userDir, "stray-file.txt"), "not a skill", "utf8");
    writeSkillIn(userDir, "real-skill", "1.0.0");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills.map((s) => s.skill.frontmatter.name)).toStrictEqual(["real-skill"]);
  });
});

describe("discoverSkills — precedence (project > user > bundled)", () => {
  it("project source wins when a skill exists in all three", async () => {
    writeSkillIn(bundledDir, "git-helper", "0.0.1");
    writeSkillIn(userDir, "git-helper", "0.0.2");
    writeSkillIn(projectDir, "git-helper", "0.0.3");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.skill.frontmatter.version).toBe("0.0.3");
    expect(skills[0]?.source).toBe("project");
  });

  it("user source wins over bundled when project doesn't have it", async () => {
    writeSkillIn(bundledDir, "shared", "0.0.1");
    writeSkillIn(userDir, "shared", "0.0.2");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.skill.frontmatter.version).toBe("0.0.2");
    expect(skills[0]?.source).toBe("user");
  });

  it("bundled is used when neither user nor project has the skill", async () => {
    writeSkillIn(bundledDir, "only-bundled", "1.0.0");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.source).toBe("bundled");
  });
});

describe("discoverSkills — failed-skill resilience", () => {
  it("a malformed SKILL.md in one source doesn't break discovery for others", async () => {
    // bundled: valid skill.
    writeSkillIn(bundledDir, "good-bundled", "1.0.0");

    // user: invalid skill (no frontmatter).
    const badDir = path.join(userDir, "bad-user");
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, "SKILL.md"), "no frontmatter at all", "utf8");

    // user: also a valid skill that should still load.
    writeSkillIn(userDir, "good-user", "2.0.0");

    // project: empty.

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    const names = skills.map((s) => s.skill.frontmatter.name).sort();
    expect(names).toStrictEqual(["good-bundled", "good-user"]);
  });

  it("a SKILL.md whose name doesn't match the directory is skipped", async () => {
    // Create a directory whose SKILL.md has a different name.
    const dir = path.join(userDir, "actual-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---
name: different-name
description: Mismatched name should fail to load.
---

Body.
`,
      "utf8",
    );

    // Plus a valid skill so we can confirm only the bad one is dropped.
    writeSkillIn(userDir, "good", "1.0.0");

    const skills = await discoverSkills({ bundledDir, userDir, projectDir });
    expect(skills.map((s) => s.skill.frontmatter.name)).toStrictEqual(["good"]);
  });
});

describe("discoverSkills — missing source directories", () => {
  it("returns empty when a source directory does not exist", async () => {
    const nonexistent = path.join(tmpRoot, "does-not-exist");
    const skills = await discoverSkills({
      bundledDir: nonexistent,
      userDir: nonexistent,
      projectDir: nonexistent,
    });
    expect(skills).toStrictEqual([]);
  });
});
