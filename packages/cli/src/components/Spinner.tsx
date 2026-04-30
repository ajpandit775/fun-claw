// Tiny braille spinner for ink. Hand-rolled rather than pulling in a
// third-party `ink-spinner` dep — it's literally one cycling glyph and
// STACK.md doesn't list a spinner dep.

import { Text } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

export function Spinner(): JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  return <Text color="cyan">{FRAMES[frame]}</Text>;
}
