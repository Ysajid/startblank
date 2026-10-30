import { describe, it, expect, vi } from "vitest";
import { noteHash, readNoteHash } from "../noteLink";

function at(hash: string) {
  vi.stubGlobal("window", { location: { hash } });
}

describe("note links", () => {
  it("round-trips paths with spaces, #, % and non-Latin names", () => {
    for (const path of ["Inbox.md", "Ideas/On walking.md", "A #1/100% done.md", "ভাবনা/নোট.md"]) {
      const hash = noteHash(path);
      expect(hash.slice(1)).not.toContain(" ");
      at(hash);
      expect(readNoteHash()).toBe(path);
    }
  });

  it("keeps folders readable and ignores other or mangled hashes", () => {
    expect(noteHash("Ideas/On walking.md")).toBe("#note=Ideas/On%20walking.md");
    at("#doc=abc123");
    expect(readNoteHash()).toBeNull();
    at("#note=%E0%A4");
    expect(readNoteHash()).toBeNull();
  });
});
