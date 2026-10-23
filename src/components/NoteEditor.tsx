import { useEffect, useRef, useState } from "react";
import { useWritingStats } from "../lib/useWritingStats";
import type { PasteRange } from "../lib/provenance";
import type { Note } from "../lib/vaultSync";
import type { FontName, WritingStats } from "../types";

export const FONT_CLASS: Record<FontName, string> = {
  typewriter: "font-write-typewriter",
  serif: "font-write-serif",
  sans: "font-write-sans",
  mono: "font-write-mono",
};

// The writing surface for one note. It is uncontrolled and owns the note's
// hand-writing record while open; mount it with a `key` per note (and per
// server version) so switching notes starts from that note's own record.
export function NoteEditor({
  note,
  font,
  onChange,
}: {
  note: Note;
  font: FontName;
  onChange: (body: string, stats: WritingStats, pasteRanges: PasteRange[]) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const { statsRef, runs, handleInput, getPasteRanges } = useWritingStats(
    note.body,
    { ...note.stats },
    note.pasteRanges
  );
  const [content, setContent] = useState(note.body);

  useEffect(() => {
    if (textareaRef.current) textareaRef.current.value = note.body;
    // Only on mount: afterwards the textarea is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    handleInput(event);
    const value = event.currentTarget.value;
    setContent(value);
    onChange(value, statsRef.current, getPasteRanges());
  }

  function onScroll(event: React.UIEvent<HTMLTextAreaElement>) {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = event.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  return (
    <div className="relative">
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={`${FONT_CLASS[font]} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-0 text-[1.2rem] leading-relaxed text-transparent`}
        style={{ minHeight: "60vh" }}
      >
        {runs.map((run, i) =>
          run.isPasted ? (
            <span key={i} style={{ backgroundColor: "var(--paste-mark)" }}>
              {content.slice(run.start, run.start + run.length)}
            </span>
          ) : (
            <span key={i}>{content.slice(run.start, run.start + run.length)}</span>
          )
        )}
      </div>
      <textarea
        ref={textareaRef}
        onInput={onInput}
        onScroll={onScroll}
        autoFocus
        placeholder="Start writing. Link other notes with [[double brackets]]."
        spellCheck
        className={`${FONT_CLASS[font]} relative block w-full resize-none border-none bg-transparent p-0 text-[1.2rem] leading-relaxed text-[var(--fg)] placeholder:italic placeholder:text-[var(--fg-muted)]`}
        style={{ minHeight: "60vh" }}
      />
    </div>
  );
}
