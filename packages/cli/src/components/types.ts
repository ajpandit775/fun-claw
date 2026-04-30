// View-model types for the chat TUI.
//
// These are distinct from the core protocol types (`Message`,
// `ContentBlock`, `ToolUseBlock`, etc.) by design — the TUI tracks
// per-tool-call live status (pending / running / done / error) which
// has no place in the wire-format types. The chat command translates
// `AgentEvent`s into reducer actions that update this view model.
//
// Components only render from these types. They do not import core
// types. This keeps the TUI render layer testable in isolation with
// hardcoded view-model fixtures.

/** Live status of a tool call as the TUI sees it. */
export type ToolCallStatus = "pending" | "running" | "done" | "error";

/** A tool call rendered inline inside an assistant message. */
export interface ToolCallView {
  /** Provider-assigned id; round-trips end-to-end per ADR-002. */
  id: string;
  /** Tool name (e.g. `"execute_bash"`). */
  name: string;
  /** Parsed input JSON. */
  input: Record<string, unknown>;
  /** Live status. Updates as the tool dispatches and completes. */
  status: ToolCallStatus;
  /** Result content (stdout/stderr summary or error message). Set when
   *  `status === "done"` or `status === "error"`. */
  result?: {
    content: string;
    isError: boolean;
  };
}

/** A single rendered part of a message. */
export type MessagePart = { type: "text"; text: string } | ({ type: "tool-call" } & ToolCallView);

/** A message in the scrollback as the TUI represents it. */
export interface ChatMessage {
  /** Stable identifier so React keys are stable across re-renders. */
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
}

/** Top-level chat status; drives the StatusBar and input-disabled state. */
export type ChatStatus = "idle" | "thinking" | "running-tools" | "error" | "aborted";
