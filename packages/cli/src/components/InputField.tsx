// User input row at the bottom of the chat TUI.
//
// Wraps `ink-text-input` with a colored prompt prefix. When the chat
// is busy (thinking / running tools), the input is disabled and shows
// a dimmed placeholder rather than the live editor. Single-line only
// for now; multiline is deferred polish.

import { Box, Text } from "ink";
// ink-text-input ships its own types but the default export shape varies
// between ESM / CJS — wrapping the import once at the call site keeps
// the rest of the file clean.
import TextInput from "ink-text-input";

export interface InputFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** When true, render a placeholder instead of the live editor. */
  disabled?: boolean;
  /** Optional placeholder text shown when disabled. */
  disabledPlaceholder?: string;
}

export function InputField({
  value,
  onChange,
  onSubmit,
  disabled,
  disabledPlaceholder,
}: InputFieldProps): JSX.Element {
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold color="cyan">
        ›
      </Text>
      {disabled === true ? (
        <Text dimColor>{disabledPlaceholder ?? "(input disabled)"}</Text>
      ) : (
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      )}
    </Box>
  );
}
