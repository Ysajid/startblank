import { StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { applyEdit, computeRuns, pasteRangesFromTags, tagsFromPasteRanges, type PasteRange } from "../provenance";
import type { WritingStats } from "../../types";

// The hand-writing record of the note being edited, kept in the editor's
// own state. Every change arrives with its exact positions and a user
// event ("input.type", "input.paste", "delete.backward", "undo", …), so
// typing, pasting and deleting are told apart without diffing the text.
//
// `tags[i] === 1` means character i was pasted (see ../provenance.ts):
// deleting pasted text takes it back out of the count, and the pasted
// ranges are marked in the editor.

export interface Provenance {
  tags: Uint8Array;
  stats: WritingStats;
}

function isPaste(tr: Transaction) {
  return tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop") || tr.isUserEvent("move.drop");
}

function isEdit(tr: Transaction) {
  return tr.isUserEvent("delete") || tr.isUserEvent("undo") || tr.isUserEvent("redo");
}

export function applyTransaction(value: Provenance, tr: Transaction): Provenance {
  if (!tr.docChanged) return value;
  const pasted = isPaste(tr);
  let tags = value.tags;
  let removedPastedChars = 0;
  let inserted = 0;
  // In document order: by the time a change is applied, everything before
  // it already is, so its start in `tags` is its position in the new text.
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    const result = applyEdit(tags, fromB, fromB + (toA - fromA), toB - fromB, pasted);
    tags = result.next;
    removedPastedChars += result.removedPastedChars;
    inserted += toB - fromB;
  });

  const stats = { ...value.stats };
  stats.pastedChars = Math.max(0, stats.pastedChars - removedPastedChars);
  if (pasted) {
    stats.pasteEvents += 1;
    stats.pastedChars += inserted;
  } else if (isEdit(tr) || inserted === 0) {
    stats.edits += 1;
  } else {
    stats.keystrokes += inserted;
  }
  return { tags, stats };
}

export const provenanceField = StateField.define<Provenance>({
  create: (state) => ({
    tags: new Uint8Array(state.doc.length),
    stats: { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 },
  }),
  update: applyTransaction,
  provide: (field) =>
    EditorView.decorations.compute([field], (state) =>
      Decoration.set(
        computeRuns(state.field(field).tags)
          .filter((run) => run.isPasted)
          .map((run) => pasted.range(run.start, run.start + run.length))
      )
    ),
});

const pasted = Decoration.mark({ class: "cm-pasted" });

export function provenance(body: string, stats: WritingStats, pasteRanges: PasteRange[]) {
  return provenanceField.init(() => ({
    tags: tagsFromPasteRanges(body.length, pasteRanges),
    stats: { ...stats },
  }));
}

export function readProvenance(value: Provenance): { stats: WritingStats; pasteRanges: PasteRange[] } {
  return { stats: { ...value.stats }, pasteRanges: pasteRangesFromTags(value.tags) };
}
