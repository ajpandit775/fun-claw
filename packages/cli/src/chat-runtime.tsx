// Fun Claw chat-runtime — the ESM half of the chat command.
//
// This file is the second tsup entry (output: dist/chat-runtime.mjs) and
// hosts everything that needs to statically import ink: the React
// wrapper component that owns chat state and integrates the agent loop,
// plus the ink mount + waitUntilExit lifecycle. The CJS bin's chat
// command (`commands/chat.ts`) dynamic-imports `startChatTui` from this
// module at action time — bridging CJS → ESM via dynamic import works
// because Node's ESM loader handles top-level-await modules transparently
// at the dynamic-import boundary.
//
// Reference docs:
//   - .claude/CLAUDE.md (Slice 6 Task 2 ink-ESM-CJS feedback entry).
//   - docs/adr/ADR-001-trust-boundaries.md (LLM is semi-trusted; tool
//     output is adversarial — the system prompt + agent loop's wrap
//     handle this layer).
//   - docs/adr/ADR-002-tool-dispatch.md (parallel dispatch; abort).

import {
  type AgentEvent,
  type FunClawLogger,
  type LLMProvider,
  type Message,
  runAgentLoop,
  type ToolCall,
  type ToolRegistry,
} from "@funclaw/core";
import { type Instance, render } from "ink";
import type * as React from "react";
import { useCallback, useReducer, useRef } from "react";
import { ChatApp } from "./components/ChatApp.js";
import type { ChatMessage, ChatStatus, MessagePart, ToolCallStatus } from "./components/types.js";

const DOUBLE_INTERRUPT_WINDOW_MS = 2000;

// ---------------------------------------------------------------------------
// View state + reducer
// ---------------------------------------------------------------------------

interface ViewState {
  messages: ChatMessage[];
  status: ChatStatus;
  iteration?: number;
}

type ViewAction =
  | { type: "user-submit"; text: string }
  | { type: "agent-event"; event: AgentEvent }
  | { type: "agent-throw"; message: string };

const INITIAL_VIEW: ViewState = { messages: [], status: "idle" };

let nextMessageIdCounter = 1;
function nextMessageId(): string {
  const id = `msg-${nextMessageIdCounter}`;
  nextMessageIdCounter += 1;
  return id;
}

function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "user-submit": {
      const userMessage: ChatMessage = {
        id: nextMessageId(),
        role: "user",
        parts: [{ type: "text", text: action.text }],
      };
      return {
        ...state,
        messages: [...state.messages, userMessage],
        status: "thinking",
      };
    }
    case "agent-event":
      return applyAgentEvent(state, action.event);
    case "agent-throw":
      return { ...state, status: "error" };
  }
}

function applyAgentEvent(state: ViewState, event: AgentEvent): ViewState {
  switch (event.type) {
    case "turn-start":
      return { ...state, status: "thinking", iteration: event.iteration };

    case "text-delta":
      return appendAssistantText(state, event.text);

    case "tool-call-start":
      return {
        ...state,
        status: "running-tools",
        messages: addOrUpdateToolCall(state.messages, event.call, "running"),
      };

    case "tool-call-result": {
      const status: ToolCallStatus = event.result.isError === true ? "error" : "done";
      return {
        ...state,
        status: "thinking",
        messages: setToolCallResult(
          state.messages,
          event.call.id,
          status,
          event.result.content,
          event.result.isError === true,
        ),
      };
    }

    case "turn-stop": {
      if (event.stopReason === "tool_use") {
        // Loop will continue; no terminal status change here.
        return state;
      }
      const finalStatus: ChatStatus =
        event.stopReason === "error"
          ? "error"
          : event.stopReason === "aborted"
            ? "aborted"
            : "idle";
      return { ...state, status: finalStatus };
    }

    case "iteration-cap-hit":
      return { ...state, status: "error" };

    case "error":
      return { ...state, status: "error" };
  }
}

function appendAssistantText(state: ViewState, text: string): ViewState {
  const messages = state.messages.slice();
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "assistant") {
    const lastPart = last.parts[last.parts.length - 1];
    if (lastPart !== undefined && lastPart.type === "text") {
      // Append to the existing text part.
      const updated: ChatMessage = {
        ...last,
        parts: [...last.parts.slice(0, -1), { type: "text", text: lastPart.text + text }],
      };
      messages[messages.length - 1] = updated;
      return { ...state, messages };
    }
    // Open a new text part inside the existing assistant message
    // (e.g., text after a tool call).
    const updated: ChatMessage = {
      ...last,
      parts: [...last.parts, { type: "text", text }],
    };
    messages[messages.length - 1] = updated;
    return { ...state, messages };
  }
  // Start a new assistant message.
  messages.push({
    id: nextMessageId(),
    role: "assistant",
    parts: [{ type: "text", text }],
  });
  return { ...state, messages };
}

function addOrUpdateToolCall(
  messages: readonly ChatMessage[],
  call: ToolCall,
  status: ToolCallStatus,
): ChatMessage[] {
  const updated = messages.slice();
  const last = updated[updated.length - 1];
  const newPart: MessagePart = {
    type: "tool-call",
    id: call.id,
    name: call.name,
    input: call.input,
    status,
  };
  if (last !== undefined && last.role === "assistant") {
    updated[updated.length - 1] = {
      ...last,
      parts: [...last.parts, newPart],
    };
  } else {
    updated.push({
      id: nextMessageId(),
      role: "assistant",
      parts: [newPart],
    });
  }
  return updated;
}

function setToolCallResult(
  messages: readonly ChatMessage[],
  callId: string,
  status: ToolCallStatus,
  content: string,
  isError: boolean,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const newParts: MessagePart[] = message.parts.map((part) => {
      if (part.type !== "tool-call" || part.id !== callId) return part;
      changed = true;
      return { ...part, status, result: { content, isError } };
    });
    if (!changed) return message;
    return { ...message, parts: newParts };
  });
}

// ---------------------------------------------------------------------------
// Chat session integration component
// ---------------------------------------------------------------------------

interface ChatSessionProps {
  provider: LLMProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  model: string;
  sessionUuid: string;
  logger: FunClawLogger;
  /** Called when the user double-taps Ctrl-C to exit the app. */
  exit: () => void;
  /**
   * Slice 9: per-turn usage callback, invoked once per turn-stop
   * event that carries usage metadata. The chat command uses this to
   * accumulate root-level token totals for the chat-exit diagnostic
   * (per ADR-003, "tokens charge to root"). Optional — when omitted,
   * usage flows past silently.
   */
  onTurnUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

function ChatSession(props: ChatSessionProps): React.ReactElement {
  const [view, dispatch] = useReducer(viewReducer, INITIAL_VIEW);

  // Non-reactive refs: protocol message history (mutated, not rendered)
  // and the current AbortController.
  const messagesRef = useRef<Message[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const lastInterruptRef = useRef(0);
  const runningRef = useRef(false);

  const handleSubmit = useCallback(
    (text: string) => {
      if (runningRef.current) {
        props.logger.warn(
          "user submitted while agent loop running; ignoring (should be unreachable — input is disabled)",
        );
        return;
      }
      runningRef.current = true;

      dispatch({ type: "user-submit", text });

      const controller = new AbortController();
      controllerRef.current = controller;

      // Snapshot of history at submit time, plus the new user message.
      const initialMessages: Message[] = [...messagesRef.current, { role: "user", content: text }];

      void (async () => {
        try {
          for await (const event of runAgentLoop({
            provider: props.provider,
            registry: props.registry,
            initialMessages,
            systemPrompt: props.systemPrompt,
            model: props.model,
            sessionUuid: props.sessionUuid,
            abortSignal: controller.signal,
            // The agent loop wraps tool-result content with ADR-001
            // boundary markers before pushing — this callback gets the
            // already-wrapped messages, safe to feed back to the loop
            // on the next user submit.
            onMessage: (message) => {
              messagesRef.current.push(message);
            },
          })) {
            // Slice 9: surface per-turn usage to the chat command's
            // root-token aggregator, if it provided a callback. Done
            // INSIDE the loop iteration so usage flows even when the
            // caller doesn't care about other event types.
            if (event.type === "turn-stop" && event.usage !== undefined) {
              props.onTurnUsage?.(event.usage);
            }
            dispatch({ type: "agent-event", event });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          props.logger.error({ err }, "agent loop threw outside dispatch");
          dispatch({ type: "agent-throw", message });
        } finally {
          runningRef.current = false;
          controllerRef.current = null;
        }
      })();
    },
    [
      props.logger,
      props.model,
      props.provider,
      props.registry,
      props.sessionUuid,
      props.systemPrompt,
      props.onTurnUsage,
    ],
  );

  const handleInterrupt = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastInterruptRef.current;
    lastInterruptRef.current = now;

    if (elapsed < DOUBLE_INTERRUPT_WINDOW_MS) {
      // Second tap within the window: exit the app.
      props.logger.info("double Ctrl-C — exiting chat");
      props.exit();
      return;
    }

    // First tap: abort the in-flight agent loop, stay in the chat.
    const controller = controllerRef.current;
    if (controller !== null && !controller.signal.aborted) {
      props.logger.info("Ctrl-C — aborting current turn");
      controller.abort();
    }
  }, [props]);

  return (
    <ChatApp
      messages={view.messages}
      status={view.status}
      {...(view.iteration !== undefined ? { iteration: view.iteration } : {})}
      onUserSubmit={handleSubmit}
      onInterrupt={handleInterrupt}
    />
  );
}

// ---------------------------------------------------------------------------
// Public entry point — called from the CJS chat command via dynamic import
// ---------------------------------------------------------------------------

export interface StartChatTuiOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  model: string;
  sessionUuid: string;
  logger: FunClawLogger;
  /** Slice 9: per-turn usage callback for root-token aggregation.
   *  Called once per agent-loop turn-stop event that carries usage. */
  onTurnUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/**
 * Mount the chat TUI with ink and resolve when the user exits (via
 * Ctrl-C double-tap or other terminal-driven exit paths). The caller
 * (CJS chat command) is responsible for cleanup — destroying the
 * Docker session, stopping the runner, etc. — after this resolves.
 */
export async function startChatTui(opts: StartChatTuiOptions): Promise<void> {
  let instance: Instance | undefined;

  const exit = (): void => {
    instance?.unmount();
  };

  instance = render(
    <ChatSession
      provider={opts.provider}
      registry={opts.registry}
      systemPrompt={opts.systemPrompt}
      model={opts.model}
      sessionUuid={opts.sessionUuid}
      logger={opts.logger}
      exit={exit}
      {...(opts.onTurnUsage !== undefined ? { onTurnUsage: opts.onTurnUsage } : {})}
    />,
    {
      // We handle Ctrl-C via useInput + the double-tap policy in
      // ChatApp / ChatSession; tell ink not to auto-unmount on its own.
      exitOnCtrlC: false,
    },
  );

  await instance.waitUntilExit();
}
