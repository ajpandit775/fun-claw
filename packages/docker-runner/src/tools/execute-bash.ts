// Fun Claw — execute_bash tool.
//
// First concrete tool the agent loop dispatches. Wraps a single
// `SessionHandle.exec` call inside `bash -c`, surfaces stdout / stderr /
// exit code as a `ToolResult` (sync handler) or as the underlying
// streaming `AsyncIterable<ExecStreamEvent>` (streaming handler).
//
// Per ADR-001, command output is adversarial input on the next turn.
// The handler does NOT escape, sanitize, or otherwise modify output —
// that's the agent loop's job in Slice 6 (it wraps the content in
// `<tool_result name="execute_bash">…</tool_result>` boundary markers
// before it reaches the LLM).
//
// Per ADR-002, throws inside the handler are caught at the dispatcher
// boundary in Slice 6 and converted to `ToolResult { isError: true }`.
// The handler may throw `FunClawError` freely.
//
// Reference docs:
//   - .claude/CLAUDE.md "Error handling contract".
//   - docs/adr/ADR-001-trust-boundaries.md (LLM is semi-trusted; tool
//     output is adversarial on the next turn).
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch; isError on
//     the way out).
//   - packages/core/src/types.ts (`ToolDefinition`, `ToolResult`).

import type { JSONSchema, ToolDefinition, ToolResult } from "@funclaw/core";
import { z } from "zod";
import type { ExecOptions, ExecStreamEvent, SessionHandle } from "../runner.js";

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

/**
 * Input schema for the `execute_bash` tool. Validated at the handler
 * boundary; the JSON Schema form is published via `executeBashTool` for
 * the LLM provider to advertise.
 */
export const ExecuteBashInputSchema = z
  .object({
    command: z
      .string()
      .min(1, "command is required")
      .describe("Shell command to execute via bash -c."),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Working directory inside the container. Defaults to /workspace."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Wall-clock timeout in milliseconds. The container is stopped if the command runs longer.",
      ),
  })
  .strict();

export type ExecuteBashInput = z.infer<typeof ExecuteBashInputSchema>;

// ---------------------------------------------------------------------------
// Tool definition (advertised to the LLM)
// ---------------------------------------------------------------------------

/**
 * `ToolDefinition` consumed by the provider abstraction's tool list.
 * `inputSchema` is a JSON Schema 2020-12 representation of
 * `ExecuteBashInputSchema`, derived via Zod 4's built-in
 * `z.toJSONSchema`. The cast to `JSONSchema` is safe — `JSONSchema` in
 * `@funclaw/core` is `Record<string, unknown>` (deliberately loose).
 */
export const executeBashTool: ToolDefinition = {
  name: "execute_bash",
  description:
    "Execute a bash command inside the sandboxed container and return stdout, stderr, and the exit code. " +
    "Commands run as a non-root user (uid 10001) with a read-only rootfs and no Docker socket access. " +
    "/workspace is bind-mounted from the agent's working directory (read-write); /tmp is a writable tmpfs. " +
    "Network access depends on the session's network mode (default: bridge / outbound allowed; can be set to none for offline-only sandboxes). " +
    "Long-running commands can be capped via timeout_ms; the container is stopped if the timeout fires.",
  inputSchema: z.toJSONSchema(ExecuteBashInputSchema) as JSONSchema,
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Validate and normalize raw tool input. Throws a `ZodError` (which the
 * dispatcher in Slice 6 will convert to a `ToolResult` with
 * `isError: true`) if the shape is wrong. Exposed so callers can
 * pre-validate before deciding between the sync and streaming
 * handlers.
 */
export function parseExecuteBashInput(raw: unknown): ExecuteBashInput {
  return ExecuteBashInputSchema.parse(raw);
}

/**
 * Optional runtime options for the sync / streaming handlers. Threads
 * an `AbortSignal` from the agent loop's dispatcher (see ADR-002) down
 * to `SessionHandle.exec` so a Ctrl-C interrupt cancels the in-flight
 * bash command, not just the LLM streaming above it.
 */
export interface RunExecuteBashOptions {
  abortSignal?: AbortSignal;
}

/**
 * Sync handler: run `bash -c <command>` inside the session container,
 * accumulate stdout / stderr, return a `ToolResult` with the combined
 * output and `isError: true` when the exit code is non-zero.
 *
 * Output composition:
 *   - stdout text (verbatim)
 *   - if stderr text non-empty: a separator and the stderr text
 *   - the exit code on a final line
 *
 * No escaping — ADR-001 makes the agent loop responsible for
 * boundary-marker wrapping before the content re-enters the LLM
 * context.
 */
export async function runExecuteBashSync(
  session: SessionHandle,
  input: ExecuteBashInput,
  toolUseId: string,
  options: RunExecuteBashOptions = {},
): Promise<ToolResult> {
  let stdoutText = "";
  let stderrText = "";
  let exitCode = -1;

  for await (const event of runExecuteBashStream(session, input, options)) {
    if (event.type === "stdout") {
      stdoutText += event.data.toString("utf8");
    } else if (event.type === "stderr") {
      stderrText += event.data.toString("utf8");
    } else {
      exitCode = event.code;
    }
  }

  const parts: string[] = [];
  if (stdoutText.length > 0) parts.push(stdoutText.replace(/\r?\n$/, ""));
  if (stderrText.length > 0) {
    parts.push(`[stderr]\n${stderrText.replace(/\r?\n$/, "")}`);
  }
  parts.push(`[exit code: ${exitCode}]`);

  const isError = exitCode !== 0;
  const result: ToolResult = {
    toolUseId,
    content: parts.join("\n"),
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * Streaming handler: returns the raw `AsyncIterable<ExecStreamEvent>`
 * from `SessionHandle.exec` so consumers (e.g., Slice 6's TUI) can
 * render stdout as it arrives. The same underlying call backs the
 * sync handler.
 */
export function runExecuteBashStream(
  session: SessionHandle,
  input: ExecuteBashInput,
  options: RunExecuteBashOptions = {},
): AsyncIterable<ExecStreamEvent> {
  const argv = ["bash", "-c", input.command];
  const opts: ExecOptions = {};
  if (input.cwd !== undefined) opts.cwd = input.cwd;
  if (input.timeout_ms !== undefined) opts.timeoutMs = input.timeout_ms;
  if (options.abortSignal !== undefined) opts.abortSignal = options.abortSignal;
  return session.exec(argv, opts);
}
