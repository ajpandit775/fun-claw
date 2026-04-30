// Root component for the chat TUI.
//
// Pure presentation component: accepts `messages`, `status`, and
// `onUserSubmit` as props and renders the three regions (scrollback,
// status bar, input). The actual agent loop wiring — translating
// `AgentEvent`s into messages, dispatching tools, managing the
// AbortController — lives in the chat command, not here. The split
// keeps the TUI testable in isolation with hardcoded fixtures.
//
// The root component owns only the local input-buffer state. All other
// state (messages, status, iteration) is lifted to the chat command
// which manages it via a reducer fed by the agent loop's events.

import { Box, useApp, useInput } from "ink";
import { useState } from "react";
import { InputField } from "./InputField.js";
import { ScrollbackPanel } from "./ScrollbackPanel.js";
import { StatusBar } from "./StatusBar.js";
import type { ChatMessage, ChatStatus } from "./types.js";

export interface ChatAppProps {
  messages: readonly ChatMessage[];
  status: ChatStatus;
  /** Iteration counter passed through to StatusBar. */
  iteration?: number;
  /** Fires when the user submits text in the input field. The chat
   *  command translates this into a new user message + a fresh agent
   *  loop turn. */
  onUserSubmit?: (text: string) => void;
  /** Fires on Ctrl-C. The first press in a busy state should abort the
   *  current turn; the second within a short window should exit the
   *  app. The chat command owns that double-tap policy; this component
   *  just signals the press. */
  onInterrupt?: () => void;
}

export function ChatApp({
  messages,
  status,
  iteration,
  onUserSubmit,
  onInterrupt,
}: ChatAppProps): JSX.Element {
  const [input, setInput] = useState("");
  const { exit } = useApp();

  // Capture Ctrl-C at the ink layer. The chat command's process-level
  // SIGINT handler also fires, but ink intercepts raw keypresses
  // before they hit the OS in some terminals — handling here keeps
  // the UX consistent across both paths.
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      if (onInterrupt !== undefined) {
        onInterrupt();
      } else {
        exit();
      }
    }
  });

  const inputDisabled = status !== "idle" && status !== "aborted";

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setInput("");
    onUserSubmit?.(trimmed);
  };

  return (
    <Box flexDirection="column">
      <ScrollbackPanel messages={messages} />
      <Box marginTop={1} flexDirection="column">
        <StatusBar status={status} {...(iteration !== undefined ? { iteration } : {})} />
        <Box marginTop={1}>
          <InputField
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            disabled={inputDisabled}
            disabledPlaceholder={
              status === "running-tools"
                ? "(running tools — Ctrl-C to abort)"
                : "(thinking — Ctrl-C to abort)"
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
