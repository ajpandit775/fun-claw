// Vertical stack of message items. Currently a thin wrapper around
// `<Box flexDirection="column">` plus the message map; exists as its
// own component so future polish (auto-scroll, grouping, message
// dividers) has a clean home without touching ChatApp.

import { Box } from "ink";
import { MessageItem } from "./MessageItem.js";
import type { ChatMessage } from "./types.js";

export function ScrollbackPanel({ messages }: { messages: readonly ChatMessage[] }): JSX.Element {
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </Box>
  );
}
