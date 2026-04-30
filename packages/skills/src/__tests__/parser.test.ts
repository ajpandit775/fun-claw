// Vitest tests for the SKILL.md parser.
//
// Parser tests use real fs + temp dirs rather than memfs because
// `parseSkillMd` reads via `fs.promises.readFile` and `fs.promises.stat`
// — both of which take real OS paths. memfs is great for the in-process
// fs-shape tests (discovery.test.ts uses it for the directory walk),
// but the parser is a thin file-reader and benefits from end-to-end
// disk-backed coverage.
//
// Per the kickoff: cover valid + many edge cases. Each test creates
// its own subdirectory under a per-test temp tree and cleans up in
// `afterEach`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFunClawError } from "@funclaw/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillMd } from "../parser.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "funclaw-parser-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSkill(dirName: string, contents: string): string {
  const dir = path.join(tmpRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  fs.writeFileSync(p, contents, "utf8");
  return p;
}

// ---------------------------------------------------------------------------

describe("parseSkillMd — happy paths", () => {
  it("parses a fully-populated frontmatter", async () => {
    const p = writeSkill(
      "git-helper",
      `---
name: git-helper
description: Helper for git rebase + squash workflows.
version: 1.2.3
author: Alice
license: Apache-2.0
custom_field: passed-through
---

# Git Helper

Body content.
`,
    );
    const skill = await parseSkillMd(p);
    expect(skill.frontmatter.name).toBe("git-helper");
    expect(skill.frontmatter.description).toBe("Helper for git rebase + squash workflows.");
    expect(skill.frontmatter.version).toBe("1.2.3");
    expect(skill.frontmatter.author).toBe("Alice");
    expect(skill.frontmatter.license).toBe("Apache-2.0");
    expect(skill.body).toContain("# Git Helper");
    expect(skill.body).toContain("Body content.");
  });

  it("defaults version to '0.0.0' when omitted", async () => {
    const p = writeSkill(
      "no-version",
      `---
name: no-version
description: Skill without an explicit version.
---

Body.
`,
    );
    const skill = await parseSkillMd(p);
    expect(skill.frontmatter.version).toBe("0.0.0");
  });

  it("handles CRLF line endings", async () => {
    const p = writeSkill(
      "crlf-skill",
      "---\r\nname: crlf-skill\r\ndescription: Tests CRLF line ending handling.\r\n---\r\n\r\nBody.\r\n",
    );
    const skill = await parseSkillMd(p);
    expect(skill.frontmatter.name).toBe("crlf-skill");
    expect(skill.body).toContain("Body.");
  });

  it("preserves unicode in description and body", async () => {
    const p = writeSkill(
      "unicode-skill",
      `---
name: unicode-skill
description: スキル説明 — em-dash, ñ, 🦀
---

# 日本語

Body with emoji 🚀 and accented chars: café résumé.
`,
    );
    const skill = await parseSkillMd(p);
    expect(skill.frontmatter.description).toBe("スキル説明 — em-dash, ñ, 🦀");
    expect(skill.body).toContain("# 日本語");
    expect(skill.body).toContain("🚀");
  });

  it("detects scripts/ directory when present", async () => {
    const p = writeSkill(
      "with-scripts",
      `---
name: with-scripts
description: Skill with a scripts directory.
---

Body.
`,
    );
    const scriptsDir = path.join(path.dirname(p), "scripts");
    fs.mkdirSync(scriptsDir);
    fs.writeFileSync(path.join(scriptsDir, "run.sh"), "echo hi\n", "utf8");

    const skill = await parseSkillMd(p);
    expect(skill.scriptsDirectory).toBe(scriptsDir);
  });

  it("returns scriptsDirectory undefined when scripts/ is absent", async () => {
    const p = writeSkill(
      "no-scripts",
      `---
name: no-scripts
description: Skill without scripts dir.
---

Body.
`,
    );
    const skill = await parseSkillMd(p);
    expect(skill.scriptsDirectory).toBeUndefined();
  });
});

describe("parseSkillMd — error paths", () => {
  async function expectFunClawCode(promise: Promise<unknown>, code: string): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(isFunClawError(caught)).toBe(true);
    if (isFunClawError(caught)) {
      expect(caught.code).toBe(code);
    }
  }

  it("FC-4001 when SKILL.md does not exist", async () => {
    await expectFunClawCode(parseSkillMd(path.join(tmpRoot, "missing", "SKILL.md")), "FC-4001");
  });

  it("FC-4002 when frontmatter delimiters are missing", async () => {
    const p = writeSkill("no-fm", "Just a regular markdown file.\n");
    await expectFunClawCode(parseSkillMd(p), "FC-4002");
  });

  it("FC-4002 when YAML between delimiters is malformed", async () => {
    const p = writeSkill(
      "bad-yaml",
      `---
name: bad-yaml
description: "unclosed quote
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4002");
  });

  it("FC-4002 when frontmatter is a YAML scalar instead of an object", async () => {
    const p = writeSkill(
      "scalar-fm",
      `---
just_a_string
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4002");
  });

  it("FC-4003 when name is missing", async () => {
    const p = writeSkill(
      "no-name",
      `---
description: Has description but no name.
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4003");
  });

  it("FC-4003 when description exceeds 200 chars", async () => {
    const longDesc = "x".repeat(201);
    const p = writeSkill(
      "long-desc",
      `---
name: long-desc
description: ${longDesc}
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4003");
  });

  it("FC-4007 when name has uppercase letters", async () => {
    const p = writeSkill(
      "BadName",
      `---
name: BadName
description: Uppercase letters not allowed.
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4007");
  });

  it("FC-4007 when name contains a slash", async () => {
    // Note: the directory name is also affected — we just need any
    // directory name; the parser checks frontmatter.name regex
    // before comparing to the directory.
    const p = writeSkill(
      "good-dir",
      `---
name: foo/bar
description: Slash should fail the regex.
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4007");
  });

  it("FC-4007 when name starts with a digit", async () => {
    const p = writeSkill(
      "1leading",
      `---
name: 1leading
description: Names must start with a letter.
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4007");
  });

  it("FC-4004 when name doesn't match parent directory", async () => {
    const p = writeSkill(
      "actual-dir",
      `---
name: different-name
description: Frontmatter name disagrees with the directory name.
---

Body.
`,
    );
    await expectFunClawCode(parseSkillMd(p), "FC-4004");
  });
});

describe("parseSkillMd — large body", () => {
  it("handles a body of 100 KB without issue", async () => {
    const bigBody = "lorem ipsum dolor sit amet ".repeat(4000); // ~108 KB
    const p = writeSkill(
      "big-skill",
      `---
name: big-skill
description: Skill with a very long body to test we don't truncate.
---

${bigBody}`,
    );
    const skill = await parseSkillMd(p);
    expect(skill.body.length).toBeGreaterThan(100_000);
    expect(skill.body).toContain("lorem ipsum");
  });
});
