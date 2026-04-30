// Public surface of @funclaw/docker-runner.
//
// The Docker sandbox lifecycle: security policy, the `DockerRunner`
// class, and the built-in tools (`execute_bash`, `write_file`).
// Primary consumers are the agent loop in `@funclaw/core` and the
// `funclaw doctor` command (which uses `listOrphanedSessions`).
//
// Named re-exports (alphabetical within each block) so the public API
// surface is explicit. When adding a new public name to a sibling
// module, also add it to one of the lists below.

// Policy types and constants
export type {
  ApprovedContainerConfig,
  ApprovedHostConfig,
  ApprovedMount,
} from "./policy.js";
export {
  SANDBOX_GID,
  SANDBOX_UID,
  SANDBOX_USER_STRING,
  validateContainerConfig,
} from "./policy.js";

// Runner types and class
export type {
  DockerRunnerConfig,
  DockerRunnerDeps,
  ExecOptions,
  ExecStreamEvent,
  OrphanedSessionInfo,
  SkillMount,
} from "./runner.js";
export { DockerRunner, SessionHandle } from "./runner.js";

// Tools
export type { ExecuteBashInput } from "./tools/execute-bash.js";
export {
  ExecuteBashInputSchema,
  executeBashTool,
  parseExecuteBashInput,
  runExecuteBashStream,
  runExecuteBashSync,
} from "./tools/execute-bash.js";
export type { RunWriteFileOptions, WriteFileInput } from "./tools/write-file.js";
export {
  parseWriteFileInput,
  resolveWriteFilePath,
  runWriteFile,
  WriteFileInputSchema,
  writeFileTool,
} from "./tools/write-file.js";
