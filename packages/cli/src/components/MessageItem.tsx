// Single message in the chat scrollback.
//
// Renders user prompts and assistant responses with inline tool calls.
// Tool calls show as small bordered boxes with a status indicator
// (○ pending, spinner running, ✓ done, ✗ error). Tool boxes always
// show their input/output rather than collapsing — collapse-by-default
// UX is deferred polish.

import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import type { ChatMessage, MessagePart, ToolCallStatus, ToolCallView } from "./types.js";

const OUTPUT_PREVIEW_LIMIT = 600;

export function MessageItem({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === "user";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "cyan" : "green"}>
        {isUser ? "you" : "claw"} ›
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {message.parts.map((part, i) => (
          // Position-stable keys are fine here — parts within a message
          // are append-only as the assistant streams; we never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
          <PartItem key={i} part={part} />
        ))}
      </Box>
    </Box>
  );
}

function PartItem({ part }: { part: MessagePart }): JSX.Element {
  if (part.type === "text") {
    return <TextPart text={part.text} />;
  }
  return <ToolCallItem call={part} />;
}

function TextPart({ text }: { text: string }): JSX.Element {
  // Empty text parts (placeholder for in-progress streaming) render a
  // dim ellipsis so the box doesn't collapse to zero height before the
  // first delta arrives.
  if (text.length === 0) {
    return <Text dimColor>…</Text>;
  }
  return <Text>{text}</Text>;
}

function ToolCallItem({ call }: { call: ToolCallView }): JSX.Element {
  const inputText = JSON.stringify(call.input);
  const truncatedInput = inputText.length > 200 ? `${inputText.slice(0, 200)}…` : inputText;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={0}>
      <Box flexDirection="row" gap={1}>
        <StatusIndicator status={call.status} />
        <Text bold>{call.name}</Text>
        <Text dimColor>id={call.id.slice(0, 12)}</Text>
      </Box>
      <Box marginTop={0}>
        <Text dimColor>{`input: ${truncatedInput}`}</Text>
      </Box>
      {call.result !== undefined && (
        <Box marginTop={0} flexDirection="column">
          <Text dimColor>output:</Text>
          {call.result.isError ? (
            <Text color="red">{previewOutput(call.result.content)}</Text>
          ) : (
            <Text>{previewOutput(call.result.content)}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function StatusIndicator({ status }: { status: ToolCallStatus }): JSX.Element {
  switch (status) {
    case "pending":
      return <Text dimColor>○</Text>;
    case "running":
      return <Spinner />;
    case "done":
      return <Text color="green">✓</Text>;
    case "error":
      return <Text color="red">✗</Text>;
  }
}

function previewOutput(content: string): string {
  if (content.length <= OUTPUT_PREVIEW_LIMIT) return content;
  const head = content.slice(0, OUTPUT_PREVIEW_LIMIT);
  const truncated = content.length - OUTPUT_PREVIEW_LIMIT;
  return `${head}\n…(${truncated.toLocaleString()} more characters truncated for display)`;
}
