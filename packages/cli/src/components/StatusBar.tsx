// One-line status display under the scrollback, above the input field.
//
// Shows the current chat status (idle / thinking / running-tools /
// error / aborted) with a glyph and a short label. Optionally shows
// the iteration counter so the user can see when the loop is heading
// toward its 25-iteration cap.

import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import type { ChatStatus } from "./types.js";

export interface StatusBarProps {
  status: ChatStatus;
  /** Optional iteration counter (1-based, nullish if no turn in flight). */
  iteration?: number;
}

export function StatusBar({ status, iteration }: StatusBarProps): JSX.Element {
  return (
    <Box flexDirection="row" gap={1}>
      <StatusGlyph status={status} />
      <Text dimColor>{label(status, iteration)}</Text>
    </Box>
  );
}

function StatusGlyph({ status }: { status: ChatStatus }): JSX.Element {
  switch (status) {
    case "idle":
      return <Text color="green">●</Text>;
    case "thinking":
      return <Spinner />;
    case "running-tools":
      return <Spinner />;
    case "error":
      return <Text color="red">●</Text>;
    case "aborted":
      return <Text color="yellow">●</Text>;
  }
}

function label(status: ChatStatus, iteration?: number): string {
  const iterPart = iteration !== undefined && iteration > 0 ? ` (turn ${iteration})` : "";
  switch (status) {
    case "idle":
      return "ready — type a message and hit enter";
    case "thinking":
      return `thinking${iterPart}…`;
    case "running-tools":
      return `running tools${iterPart}…`;
    case "error":
      return "something went wrong — see the message above";
    case "aborted":
      return "aborted — press enter on a new prompt to continue, or Ctrl-C again to exit";
  }
}
