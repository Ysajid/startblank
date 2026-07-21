import { useCallback, useRef } from "react";
import type { WritingStats } from "../types";

function emptyStats(): WritingStats {
  return { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 };
}

/**
 * Classifies each `input` event by its native `inputType` rather than raw
 * keydowns, so typing is counted correctly across IME composition, mobile
 * keyboards, and physical keyboards alike, without double-counting.
 */
export function useWritingStats(initial?: WritingStats) {
  const statsRef = useRef<WritingStats>(initial ?? emptyStats());

  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const inputType = native.inputType ?? "";
    const data = native.data ?? "";
    const stats = statsRef.current;

    if (inputType.startsWith("delete") || inputType.startsWith("history")) {
      stats.edits += 1;
    } else if (inputType === "insertFromPaste" || inputType === "insertFromPasteAsQuotation") {
      stats.pasteEvents += 1;
      stats.pastedChars += data.length;
    } else if (inputType === "insertFromDrop") {
      stats.pasteEvents += 1;
      stats.pastedChars += data.length;
    } else {
      stats.keystrokes += Math.max(data.length, 1);
    }
  }, []);

  const reset = useCallback((next?: WritingStats) => {
    statsRef.current = next ?? emptyStats();
  }, []);

  return { statsRef, handleInput, reset };
}
