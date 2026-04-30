// Fun Claw — write_file tool.
//
// Second built-in tool (after `execute_bash`). Lets the agent write
// arbitrary text or binary content to a file inside `/workspace`.
// This is the primary surface the agent uses to author skills (Flow 7
// in REQUIREMENTS.md): "the agent uses its built-in file-write tools
// to create a skill directory in `~/.funclaw/skills/<name>/`" — except
// per the ADR-001 trust boundary, the agent writes into /workspace
// inside the sandbox, and the chat command (or the user) is
// responsible for moving authored skills to the user's skills
// directory afterward. The /skills tree is read-only at the mount
// boundary; FC-1018 enforces this.
//
// Path traversal protection is the security-critical part of this
// tool. The Zod schema rejects malformed paths at the boundary, but
// we then re-validate inside the handler with three distinct codes:
//
//   - FC-1030 — path traversal attempt (`..` segments).
//   - FC-1031 — absolute path rejected (leading `/`, drive letter).
//   - FC-1032 — invalid characters in path (NUL, leading whitespace).
//
// All three codes are FC-1xxx because this is docker-runner territory
// (the container is the failure surface). Distinct failure modes get
// distinct codes (the "narrow-specificity" rule documented in
// CLAUDE.md saved feedback).
//
// Reference docs:
//   - .claude/CLAUDE.md "Key rules" (path traversal protection,
//     cross-platform discipline).
//   - REQUIREMENTS.md Flow 7 (agent authors skills via write_file).
//   - docs/adr/ADR-001-trust-boundaries.md (container is untrusted;
//     the host's parser is the only path that promotes content
//     into /skills).

import * as path from "node:path";
import { funClawError, type JSONSchema, type ToolDefinition, type ToolResult } from "@funclaw/core";
import { z } from "zod";
import type { SessionHandle } from "../runner.js";

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

/**
 * Input schema for `write_file`. The path is a relative POSIX path
 * inside `/workspace`; the handler validates it further before any
 * filesystem touch. Content is the bytes to write (string for utf-8,
 * base64 for binary). Encoding defaults to utf-8 — the binary path
 * is rare and explicit so accidental misuse stays unlikely.
 */
export const WriteFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path is required")
      .describe(
        "Relative POSIX path inside /workspace, e.g. 'src/foo.ts'. No leading slash, no '..' segments, no drive letters.",
      ),
    content: z
      .string()
      .describe(
        "File content. UTF-8 string when encoding is 'utf-8'; base64-encoded when encoding is 'binary'.",
      ),
    encoding: z
      .enum(["utf-8", "binary"])
      .default("utf-8")
      .describe(
        "How to interpret the content field. 'utf-8' (default) writes the string verbatim; 'binary' base64-decodes first.",
      ),
  })
  .strict();

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * `ToolDefinition` for the LLM. Description is verbose-but-direct so
 * the model picks `write_file` over `execute_bash` heredoc tricks for
 * file creation (heredocs through `bash -c` are a quoting maze — this
 * tool is the safer path).
 */
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write text or binary content to a file inside the sandboxed workspace at /workspace. " +
    "Creates parent directories as needed. Overwrites existing files. " +
    "The path is relative to /workspace; absolute paths and '..' segments are rejected. " +
    "For text files, set encoding to 'utf-8' (default) and pass the content directly. " +
    "For binary files, set encoding to 'binary' and base64-encode the content.",
  inputSchema: z.toJSONSchema(WriteFileInputSchema) as JSONSchema,
};

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate a write_file path and return its normalized absolute
 * in-container POSIX path under /workspace. Throws FC-1030 / FC-1031
 * / FC-1032 on rejection.
 *
 * Exposed so consumers (tests, future tools) can reuse the same
 * traversal-protection logic without re-implementing it.
 */
export function resolveWriteFilePath(rawPath: string): string {
  // (FC-1032) Invalid characters: NUL byte, leading/trailing whitespace,
  // empty after trim. These corrupt argv quoting or imply a bug.
  if (rawPath.length === 0 || rawPath !== rawPath.trim()) {
    throw funClawError({
      code: "FC-1032",
      message: `write_file path is empty or has leading/trailing whitespace. Got: ${JSON.stringify(rawPath)}.`,
      data: { rawPath },
    });
  }
  if (rawPath.includes("\0")) {
    throw funClawError({
      code: "FC-1032",
      message: "write_file path contains a NUL byte, which is rejected.",
      data: { rawPath },
    });
  }

  // (FC-1031) Absolute path: leading `/` (POSIX) or `C:\` /
  // `C:/` (Windows drive letters). Both are absolute paths the
  // tool refuses to honor — write_file is /workspace-only.
  if (rawPath.startsWith("/")) {
    throw funClawError({
      code: "FC-1031",
      message: `write_file path "${rawPath}" is absolute (leading '/'). Only relative paths inside /workspace are allowed.`,
      data: { rawPath },
    });
  }
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    throw funClawError({
      code: "FC-1031",
      message: `write_file path "${rawPath}" looks like a Windows drive-letter path. Only relative POSIX paths inside /workspace are allowed.`,
      data: { rawPath },
    });
  }

  // (FC-1030) Path traversal: any `..` segment, before or after
  // normalization. We check both the raw segments AND the result of
  // posix.normalize — `a/b/../../etc/passwd` normalizes to `etc/passwd`
  // but the raw form contains `..`, which is the attacker pattern.
  // Normalize first to coalesce `./` and double slashes.
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) {
    throw funClawError({
      code: "FC-1030",
      message: `write_file path "${rawPath}" contains '..' segments after normalization. Path traversal is rejected.`,
      data: { rawPath, normalized },
    });
  }
  // Defense in depth: even after normalization, the result must not
  // be absolute. (Could happen if the input was tricky enough to
  // normalize into a leading slash.)
  if (normalized.startsWith("/") || normalized.startsWith("..")) {
    throw funClawError({
      code: "FC-1030",
      message: `write_file path "${rawPath}" normalized to "${normalized}", which escapes /workspace. Rejected.`,
      data: { rawPath, normalized },
    });
  }

  return path.posix.join("/workspace", normalized);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Validate raw input and return the typed shape. Throws ZodError on
 * shape mismatch (the agent loop's dispatcher converts that into a
 * `tool_result` with `isError: true`).
 */
export function parseWriteFileInput(raw: unknown): WriteFileInput {
  return WriteFileInputSchema.parse(raw);
}

export interface RunWriteFileOptions {
  abortSignal?: AbortSignal;
}

/**
 * Execute the write_file tool against a live container session.
 *
 * **Implementation:** content is base64-encoded on the host, then a
 * single `mkdir -p <dir> && echo '<base64>' | base64 -d > <file>`
 * shell command runs in the container. Base64 only emits
 * `[A-Za-z0-9+/=]` so the encoded payload has no shell-quoting
 * hazards.
 *
 * **Why not stdin streaming?** `SessionHandle.exec` supports an
 * optional stdin parameter, but dockerode's hijacked-stream `.end()`
 * is interpreted by the
 * Docker daemon as "client disconnected" rather than "stdin EOF on
 * exec" — the child gets killed and `inspect.ExitCode` returns null
 * (rendered as -1 by the runner). Base64-via-shell avoids the issue
 * entirely; the stdin primitive is still available in
 * `ExecOptions.stdin` for callers that need it (e.g., interactive
 * REPL-style tools in future slices).
 *
 * Failure modes:
 *   - Path validation throws FC-1030 / FC-1031 / FC-1032 before any
 *     container interaction.
 *   - Container exec failures surface as FC-1021 from
 *     `SessionHandle.exec`.
 *   - A non-zero shell exit yields a `ToolResult` with
 *     `isError: true` and the shell's stderr in `content`.
 */
export async function runWriteFile(
  session: SessionHandle,
  input: WriteFileInput,
  toolUseId: string,
  options: RunWriteFileOptions = {},
): Promise<ToolResult> {
  const absPath = resolveWriteFilePath(input.path);
  // Decode the input content into a Buffer of bytes, regardless of
  // encoding. Then re-encode as base64 for transmission via the shell
  // argv. The result is identical bytes inside the container.
  const contentBytes: Buffer =
    input.encoding === "binary"
      ? Buffer.from(input.content, "base64")
      : Buffer.from(input.content, "utf8");
  const byteLength = contentBytes.byteLength;
  const base64Payload = contentBytes.toString("base64");

  const dir = posixDirname(absPath);
  // bash -c is invoked argv-style via SessionHandle.exec, not via the
  // forbidden host-side `child_process.exec(string)`. The string
  // below is the SCRIPT that the in-container bash interprets.
  //
  // The base64 payload is single-quoted; per its character set
  // (`[A-Za-z0-9+/=]`) it cannot contain a single quote, so single-
  // quoting is unconditionally safe. The shellEscape helper handles
  // the path strings for the same reason as the validator's regex
  // already excludes `'` from the allowed character set.
  const script =
    `mkdir -p ${shellEscape(dir)} && ` +
    `echo '${base64Payload}' | base64 -d > ${shellEscape(absPath)}`;

  let stdoutText = "";
  let stderrText = "";
  let exitCode = -1;

  for await (const event of session.exec(["bash", "-c", script], {
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
  })) {
    if (event.type === "stdout") {
      stdoutText += event.data.toString("utf8");
    } else if (event.type === "stderr") {
      stderrText += event.data.toString("utf8");
    } else {
      exitCode = event.code;
    }
  }

  if (exitCode !== 0) {
    const detail = stderrText.trim().length > 0 ? stderrText.trim() : stdoutText.trim();
    return {
      toolUseId,
      content:
        `write_file failed (exit ${exitCode}) writing ${byteLength} byte(s) to ${absPath}` +
        (detail.length > 0 ? `:\n${detail}` : "."),
      isError: true,
    };
  }

  return {
    toolUseId,
    content: `Wrote ${byteLength} byte(s) to ${absPath} (encoding: ${input.encoding}).`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POSIX-only dirname. We never run write_file with Windows-shaped
 * paths; the validator above guarantees the input is POSIX.
 */
function posixDirname(p: string): string {
  return path.posix.dirname(p);
}

/**
 * Single-quote a POSIX path for safe inclusion in a `bash -c` script.
 * The validator already rejects characters that would break this,
 * but defense in depth: replace any embedded single quotes with the
 * `'\''` POSIX trick.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
