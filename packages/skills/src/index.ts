// Public surface of `@funclaw/skills`.
//
// Slice 8 introduces the skills loader. Per CLAUDE.md "Slice 1, Task 3
// saved feedback", the barrel uses explicit named re-exports so private
// helpers in sibling modules don't leak into the public API by
// accident. When you add a new public name, also add it here.
//
// Reference docs:
//   - .claude/CLAUDE.md (slice plan; saved feedback for barrel
//     re-export discipline; Slice 8 pre-decisions).

// Discovery (three-source precedence walker)
export type { DiscoverSkillsOptions } from "./discovery.js";
export { discoverSkills } from "./discovery.js";

// Error helpers (FC-4xxx FunClawErrors). Exported so chat.ts and
// tests can construct the same shapes when needed.
export {
  frontmatterSchemaError,
  frontmatterYamlError,
  nameMismatchError,
  scriptsDirectoryUnreadableError,
  skillMdMissingError,
  skillNameConflictError,
  skillNameForbiddenError,
} from "./errors.js";

// Parser
export { parseSkillMd, SkillFrontmatterSchema, validateFrontmatter } from "./parser.js";

// Public types
export type { DiscoveredSkill, Skill, SkillFrontmatter, SkillSource } from "./types.js";
