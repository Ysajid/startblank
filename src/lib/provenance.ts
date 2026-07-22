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

// Finds the single contiguous region that changed between two textarea
// values via common prefix/suffix — works uniformly for insertion,
// deletion, and "select some text and type/paste over it".
export function diffRange(oldValue: string, newValue: string) {
  const maxPrefix = Math.min(oldValue.length, newValue.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && oldValue[prefixLen] === newValue[prefixLen]) prefixLen++;

  const maxSuffix = Math.min(oldValue.length - prefixLen, newValue.length - prefixLen);
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    oldValue[oldValue.length - 1 - suffixLen] === newValue[newValue.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    oldStart: prefixLen,
    oldEnd: oldValue.length - suffixLen,
    newStart: prefixLen,
    newEnd: newValue.length - suffixLen,
  };
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
