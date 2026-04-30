// Public surface of @funclaw/docker-runner.
//
// Slice 5 introduces the docker-runner package: the security policy,
// the `DockerRunner` lifecycle wrapper, and the first concrete tool
// (`execute_bash`). Slice 6's agent loop and Slice 8's skill scripts
// are the primary consumers; Slice 10's doctor consumes
// `listOrphanedSessions`.
//
// Named re-exports (alphabetical within each block) so the public API
// surface is explicit. Per the saved-feedback rule, when adding a new
// public name to a sibling module, also add it to one of the lists
// below.

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
