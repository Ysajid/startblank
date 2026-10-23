import { applyEdit, pasteRangesFromTags, tagsFromPasteRanges, type PasteRange } from "./provenance";
import type { WritingStats } from "../types";

// A note on the server is a plain Markdown file and nothing else, so agents,
// AI services, search indexes and other editors can read and write it like
// any other file.
//
// Its hand-writing record (the counts behind the Blank Score and which
// characters were not written here) lives in a sidecar file,
// `.startblank/record/<note path>.json`, together with a copy of the text
// as the app last saved it. That copy is what keeps the record honest when
// something else edits the note: the difference between it and the file is
// exactly the text written outside startblank, and is marked as such.

export interface NoteContent {
  body: string;
  stats: WritingStats;
  pasteRanges: PasteRange[];
}

interface StoredRecord {
  v: 2;
  keystrokes: number;
  edits: number;
  pasteEvents: number;
  pastedChars: number;
  pasted: [number, number][];
  body: string;
}

export const RECORD_DIR = ".startblank/record";

export function recordPath(notePath: string): string {
  return `${RECORD_DIR}/${notePath}.json`;
}

export function notePathFromRecord(path: string): string | null {
  const prefix = `${RECORD_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".json")) return null;
  return path.slice(prefix.length, -".json".length);
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function emptyStats(): WritingStats {
  return { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 };
}

export function serializeRecord({ body, stats, pasteRanges }: NoteContent): string {
  const record: StoredRecord = {
    v: 2,
    keystrokes: stats.keystrokes,
    edits: stats.edits,
    pasteEvents: stats.pasteEvents,
    pastedChars: stats.pastedChars,
    pasted: pasteRanges.map((r) => [r.start, r.length]),
    body,
  };
  return JSON.stringify(record);
}

function parseRecord(text: string | null): NoteContent | null {
  if (text === null) return null;
  try {
    const r = JSON.parse(text);
    if (
      r?.v !== 2 ||
      typeof r.body !== "string" ||
      !isCount(r.keystrokes) ||
      !isCount(r.edits) ||
      !isCount(r.pasteEvents) ||
      !isCount(r.pastedChars) ||
      !Array.isArray(r.pasted)
    ) {
      return null;
    }
    return {
      body: r.body,
      stats: { keystrokes: r.keystrokes, edits: r.edits, pasteEvents: r.pasteEvents, pastedChars: r.pastedChars },
      pasteRanges: r.pasted
        .filter((p: unknown) => Array.isArray(p) && isCount(p[0]) && isCount(p[1]))
        .map(([start, length]: [number, number]) => ({ start, length })),
    };
  } catch {
    return null;
  }
}

// ---- Attributing outside edits ---------------------------------------------

interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.match(/[^\n]*\n|[^\n]+$/g)!;
}

// Words (in any script), runs of whitespace, and single punctuation marks.
function splitWords(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? [];
}

// Above this many token pairs, fall back to one region spanning the first
// to the last change rather than spend the time on an exact diff.
const MAX_DIFF_CELLS = 4_000_000;

interface TokenHunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

// Longest-common-subsequence diff of two token lists: the runs of `a`
// replaced by runs of `b`, in order.
function lcsHunks(a: string[], b: string[]): TokenHunk[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return [{ a0: head, a1: head + n, b0: head, b1: head + m }];

  // lcs[i * w + j]: LCS length of a[head+i..] and b[head+j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const hunks: TokenHunk[] = [];
  let open: { a0: number; b0: number } | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      if (open) hunks.push({ ...open, a1: head + i, b1: head + j });
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) open = { a0: head + i, b0: head + j };
    if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) j++;
    else i++;
  }
  if (open) hunks.push({ ...open, a1: head + n, b1: head + m });
  return hunks;
}

function offsets(tokens: string[], start = 0): number[] {
  const out = [start];
  for (const t of tokens) out.push(out[out.length - 1] + t.length);
  return out;
}

// The regions that differ between two versions of a note: a line diff to
// find the changed blocks, then a word diff inside each block, so an agent
// rewording one phrase doesn't claim the rest of the line.
export function diffHunks(oldText: string, newText: string): Hunk[] {
  const aLines = splitLines(oldText);
  const bLines = splitLines(newText);
  const aLineAt = offsets(aLines);
  const bLineAt = offsets(bLines);

  const hunks: Hunk[] = [];
  for (const block of lcsHunks(aLines, bLines)) {
    const aStart = aLineAt[block.a0];
    const bStart = bLineAt[block.b0];
    const aWords = splitWords(oldText.slice(aStart, aLineAt[block.a1]));
    const bWords = splitWords(newText.slice(bStart, bLineAt[block.b1]));
    const aWordAt = offsets(aWords, aStart);
    const bWordAt = offsets(bWords, bStart);
    for (const h of lcsHunks(aWords, bWords)) {
      hunks.push({
        oldStart: aWordAt[h.a0],
        oldEnd: aWordAt[h.a1],
        newStart: bWordAt[h.b0],
        newEnd: bWordAt[h.b1],
      });
    }
  }
  return hunks;
}

// Carries a record forward onto a version of the note that was changed
// outside the app: every inserted character is marked as not written here
// (exactly like a paste), and removed text drops out of the counts.
function reconcile(recorded: NoteContent, body: string): NoteContent {
  const hunks = diffHunks(recorded.body, body);
  let tags = tagsFromPasteRanges(recorded.body.length, recorded.pasteRanges);
  const stats = { ...recorded.stats };
  // Back to front, so earlier offsets stay valid as later ones change size.
  for (let k = hunks.length - 1; k >= 0; k--) {
    const h = hunks[k];
    const inserted = h.newEnd - h.newStart;
    const { next, removedPastedChars } = applyEdit(tags, h.oldStart, h.oldEnd, inserted, true);
    tags = next;
    stats.pastedChars = Math.max(0, stats.pastedChars - removedPastedChars) + inserted;
    if (inserted > 0) stats.pasteEvents += 1;
  }
  return { body, stats, pasteRanges: pasteRangesFromTags(tags) };
}

// ---- Loading -----------------------------------------------------------------

export interface LoadedNote {
  content: NoteContent;
  // Still in the old format (record inside the note): save it again to
  // move the record out and leave the note as clean Markdown.
  migrate: boolean;
}

// v1 kept the record as a `startblank:` frontmatter line inside the note.
const LEGACY_KEY = "startblank:";

function readLegacy(text: string): NoteContent | null {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---", 3);
  if (close === -1 || (close + 4 < text.length && text[close + 4] !== "\n")) return null;
  const lines = text.slice(4, close).split("\n");
  const idx = lines.map((l) => l.startsWith(LEGACY_KEY)).lastIndexOf(true);
  if (idx === -1) return null;
  try {
    const r = JSON.parse(lines[idx].slice(LEGACY_KEY.length));
    if (r?.v !== 1) return null;
    const rest = text.slice(close + 5);
    const others = lines.filter((_, i) => i !== idx);
    const body = others.length > 0 ? `---\n${others.join("\n")}\n---\n${rest}` : rest;
    return parseRecord(JSON.stringify({ ...r, v: 2, body }));
  } catch {
    return null;
  }
}

export function loadNote(fileText: string, recordText: string | null): LoadedNote {
  const text = fileText.replace(/\r\n/g, "\n");

  const legacy = readLegacy(text);
  if (legacy) return { content: legacy, migrate: true };

  // Reconciling is deterministic, so there's nothing to write back: the
  // record keeps describing the text as the app last saved it, and every
  // device (and every later outside edit) diffs from that same point. A
  // missing record diffs from nothing — the whole note was written
  // elsewhere.
  const recorded = parseRecord(recordText) ?? { body: "", stats: emptyStats(), pasteRanges: [] };
  return {
    content: recorded.body === text ? recorded : reconcile(recorded, text),
    migrate: false,
  };
}

// The Markdown a reader should see: the body without any frontmatter block.
export function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const close = body.indexOf("\n---", 3);
  if (close === -1 || (close + 4 < body.length && body[close + 4] !== "\n")) return body;
  return body.slice(close + 5);
}
