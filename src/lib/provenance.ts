// Tracks, per character of the current text, whether it arrived by typing
// or by paste — so pasted text can be marked in the editor, and deleting it
// actually removes it from the Blank Score's paste count instead of leaving
// a permanent scar. `tags[i] === 1` means character i is pasted.

export interface PasteRange {
  start: number;
  length: number;
}

export interface Run {
  start: number;
  length: number;
  isPasted: boolean;
}

export function applyEdit(
  tags: Uint8Array,
  oldStart: number,
  oldEnd: number,
  insertedLength: number,
  insertIsPasted: boolean
): { next: Uint8Array; removedPastedChars: number } {
  let removedPastedChars = 0;
  for (let i = oldStart; i < oldEnd; i++) {
    if (tags[i] === 1) removedPastedChars++;
  }

  const next = new Uint8Array(tags.length - (oldEnd - oldStart) + insertedLength);
  next.set(tags.subarray(0, oldStart), 0);
  if (insertIsPasted && insertedLength > 0) {
    next.fill(1, oldStart, oldStart + insertedLength);
  }
  next.set(tags.subarray(oldEnd), oldStart + insertedLength);

  return { next, removedPastedChars };
}

export function computeRuns(tags: Uint8Array): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < tags.length) {
    const isPasted = tags[i] === 1;
    let j = i + 1;
    while (j < tags.length && (tags[j] === 1) === isPasted) j++;
    runs.push({ start: i, length: j - i, isPasted });
    i = j;
  }
  return runs;
}

export function pasteRangesFromTags(tags: Uint8Array): PasteRange[] {
  return computeRuns(tags)
    .filter((run) => run.isPasted)
    .map(({ start, length }) => ({ start, length }));
}

export function tagsFromPasteRanges(length: number, ranges: PasteRange[]): Uint8Array {
  const tags = new Uint8Array(length);
  for (const range of ranges) {
    const end = Math.min(length, range.start + range.length);
    for (let i = Math.max(0, range.start); i < end; i++) tags[i] = 1;
  }
  return tags;
}
