import { useCallback, useRef, useState } from "react";
import type { WritingStats } from "../types";
import {
  applyEdit,
  computeRuns,
  diffRange,
  pasteRangesFromTags,
  tagsFromPasteRanges,
  type PasteRange,
  type Run,
} from "./provenance";

function emptyStats(): WritingStats {
  return { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 };
}

/**
 * Classifies each `input` event by its native `inputType` and by diffing the
 * textarea's value against its previous value (rather than raw keydowns or
 * `event.data` alone), so typing, deleting, and pasting are all counted
 * correctly — including "select some pasted text and type/paste over it" —
 * across IME composition, mobile keyboards, and physical keyboards alike.
 *
 * Per-character provenance (`tags`) is kept alongside the counts: deleting
 * previously-pasted characters removes them from `pastedChars` instead of
 * leaving it permanently inflated, and `runs` exposes the pasted ranges so
 * the editor can mark them.
 */
export function useWritingStats(
  initialContent = "",
  initialStats?: WritingStats,
  initialPasteRanges: PasteRange[] = []
) {
  const statsRef = useRef<WritingStats>(initialStats ?? emptyStats());
  const tagsRef = useRef<Uint8Array>(tagsFromPasteRanges(initialContent.length, initialPasteRanges));
  const prevValueRef = useRef<string>(initialContent);
  const [runs, setRuns] = useState<Run[]>(() => computeRuns(tagsRef.current));

  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const inputType = native.inputType ?? "";
    const newValue = event.currentTarget.value;
    const oldValue = prevValueRef.current;

    const { oldStart, oldEnd, newStart, newEnd } = diffRange(oldValue, newValue);
    const insertedLength = newEnd - newStart;
    const isPasteLike =
      inputType === "insertFromPaste" ||
      inputType === "insertFromPasteAsQuotation" ||
      inputType === "insertFromDrop";

    const { next, removedPastedChars } = applyEdit(
      tagsRef.current,
      oldStart,
      oldEnd,
      insertedLength,
      isPasteLike
    );
    tagsRef.current = next;
    prevValueRef.current = newValue;

    const stats = statsRef.current;
    stats.pastedChars = Math.max(0, stats.pastedChars - removedPastedChars);

    if (inputType.startsWith("delete") || inputType.startsWith("history")) {
      stats.edits += 1;
    } else if (isPasteLike) {
      stats.pasteEvents += 1;
      stats.pastedChars += insertedLength;
    } else if (insertedLength > 0) {
      stats.keystrokes += insertedLength;
    }

    setRuns(computeRuns(next));
  }, []);

  const reset = useCallback(
    (content = "", stats?: WritingStats, pasteRanges: PasteRange[] = []) => {
      statsRef.current = stats ?? emptyStats();
      tagsRef.current = tagsFromPasteRanges(content.length, pasteRanges);
      prevValueRef.current = content;
      setRuns(computeRuns(tagsRef.current));
    },
    []
  );

  const getPasteRanges = useCallback(() => pasteRangesFromTags(tagsRef.current), []);

  return { statsRef, runs, handleInput, reset, getPasteRanges };
}
