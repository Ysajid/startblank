import { describe, it, expect } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { provenance, provenanceField, readProvenance } from "../editor/provenance";

const S0 = { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 };

function start(body = "", pasteRanges: { start: number; length: number }[] = []) {
  return EditorState.create({ doc: body, extensions: [provenance(body, S0, pasteRanges)] });
}
const read = (s: EditorState) => readProvenance(s.field(provenanceField));

describe("editor provenance", () => {
  it("counts typing, pasting and deleting from the editor's own events", () => {
    let s = start();
    s = s.update({ changes: { from: 0, insert: "hello " }, userEvent: "input.type" }).state;
    s = s.update({ changes: { from: 6, insert: "pasted" }, userEvent: "input.paste" }).state;
    expect(read(s).stats).toEqual({ keystrokes: 6, edits: 0, pasteEvents: 1, pastedChars: 6 });
    expect(read(s).pasteRanges).toEqual([{ start: 6, length: 6 }]);

    // Deleting part of the pasted text takes it back out of the count.
    s = s.update({ changes: { from: 9, to: 12 }, userEvent: "delete.backward" }).state;
    expect(read(s).stats).toEqual({ keystrokes: 6, edits: 1, pasteEvents: 1, pastedChars: 3 });
    expect(read(s).pasteRanges).toEqual([{ start: 6, length: 3 }]);

    // Typing over pasted text replaces it with typed text.
    s = s.update({ changes: { from: 6, to: 9, insert: "you" }, userEvent: "input.type" }).state;
    expect(read(s).stats.pastedChars).toBe(0);
    expect(read(s).pasteRanges).toEqual([]);
    expect(s.doc.toString()).toBe("hello you");
  });

  it("handles several changes in one step (multiple cursors) and keeps earlier marks in place", () => {
    let s = start("ab cd", [{ start: 3, length: 2 }]);
    s = s.update({
      changes: [
        { from: 0, insert: "XX" },
        { from: 2, insert: "Y" },
      ],
      selection: EditorSelection.cursor(0),
      userEvent: "input.type",
    }).state;
    expect(s.doc.toString()).toBe("XXabY cd");
    expect(read(s).stats.keystrokes).toBe(3);
    expect(read(s).pasteRanges).toEqual([{ start: 6, length: 2 }]);
  });

  it("counts undo as an edit, not typing", () => {
    let s = start("abc");
    s = s.update({ changes: { from: 3, insert: "d" }, userEvent: "undo" }).state;
    expect(read(s).stats).toEqual({ keystrokes: 0, edits: 1, pasteEvents: 0, pastedChars: 0 });
  });
});
