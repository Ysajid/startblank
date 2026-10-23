import type { PasteRange } from "./provenance";
import type { WritingStats } from "../types";

// A note on the server is a plain Markdown file — readable in any editor,
// droppable into an Obsidian vault. Its hand-writing record (the counts
// behind the Blank Score, and which characters were pasted) rides along as
// a single `startblank:` line of JSON in the YAML frontmatter, so the
// record travels with the file across devices instead of living in a
// database row.
//
// The `startblank:` line is the only part of the file the editor never
// shows. Any other frontmatter the user wrote stays in the body, so paste
// offsets are always relative to exactly the text the editor displays.

export interface NoteContent {
  body: string;
  stats: WritingStats;
  pasteRanges: PasteRange[];
}

interface StoredRecord {
  v: 1;
  keystrokes: number;
  edits: number;
  pasteEvents: number;
  pastedChars: number;
  pasted: [number, number][];
}

const KEY = "startblank:";

function splitFrontmatter(text: string): { lines: string[]; rest: string } | null {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return null;
  const afterClose = close + 4;
  if (afterClose < text.length && text[afterClose] !== "\n") return null;
  const inner = text.slice(4, close + 1);
  return {
    lines: inner === "" ? [] : inner.slice(0, -1).split("\n"),
    rest: text.slice(afterClose + 1),
  };
}

function joinFrontmatter(lines: string[], rest: string): string {
  return `---\n${lines.map((l) => `${l}\n`).join("")}---\n${rest}`;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function parseRecord(json: string): StoredRecord | null {
  try {
    const r = JSON.parse(json);
    if (
      r?.v !== 1 ||
      !isCount(r.keystrokes) ||
      !isCount(r.edits) ||
      !isCount(r.pasteEvents) ||
      !isCount(r.pastedChars) ||
      !Array.isArray(r.pasted)
    ) {
      return null;
    }
    return r as StoredRecord;
  } catch {
    return null;
  }
}

function lastIndexWhere<T>(items: T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

export function parseNoteFile(raw: string): NoteContent {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = splitFrontmatter(text);
  const idx = fm ? lastIndexWhere(fm.lines, (l) => l.startsWith(KEY)) : -1;
  const record = fm && idx !== -1 ? parseRecord(fm.lines[idx].slice(KEY.length)) : null;

  if (!fm || idx === -1 || !record) {
    // Written somewhere else (another editor, a file dropped into the
    // vault): none of it was typed here, so it counts as pasted — the same
    // as if it had been pasted in. Typing over it earns the score back.
    return {
      body: text,
      stats: { keystrokes: 0, edits: 0, pasteEvents: text ? 1 : 0, pastedChars: text.length },
      pasteRanges: text ? [{ start: 0, length: text.length }] : [],
    };
  }

  const others = fm.lines.filter((_, i) => i !== idx);
  const body = others.length > 0 ? joinFrontmatter(others, fm.rest) : fm.rest;
  return {
    body,
    stats: {
      keystrokes: record.keystrokes,
      edits: record.edits,
      pasteEvents: record.pasteEvents,
      pastedChars: record.pastedChars,
    },
    pasteRanges: record.pasted
      .filter((r) => Array.isArray(r) && isCount(r[0]) && isCount(r[1]))
      .map(([start, length]) => ({ start, length })),
  };
}

export function serializeNoteFile({ body, stats, pasteRanges }: NoteContent): string {
  const record: StoredRecord = {
    v: 1,
    keystrokes: stats.keystrokes,
    edits: stats.edits,
    pasteEvents: stats.pasteEvents,
    pastedChars: stats.pastedChars,
    pasted: pasteRanges.map((r) => [r.start, r.length]),
  };
  const line = `${KEY} ${JSON.stringify(record)}`;

  // Prefer tucking the record into the user's own frontmatter, but only when
  // that parses back to the identical body — odd shapes (an empty block, a
  // closing fence with no newline) get a block of their own on top instead,
  // which always round-trips.
  const fm = splitFrontmatter(body);
  if (fm && fm.lines.length > 0) {
    const merged = joinFrontmatter([...fm.lines, line], fm.rest);
    if (parseNoteFile(merged).body === body) return merged;
  }
  return joinFrontmatter([line], body);
}

// The Markdown a reader should see: the body without any frontmatter block.
export function stripFrontmatter(body: string): string {
  return splitFrontmatter(body)?.rest ?? body;
}
