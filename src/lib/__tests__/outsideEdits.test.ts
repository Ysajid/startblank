import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { agentWrite, db, reset } from "./fakeVault";

vi.mock("../vaultStorage", () => import("./fakeVault"));

beforeAll(() => {
  (globalThis as any).window = globalThis;
});
beforeEach(reset);

const S = (k: number) => ({ keystrokes: k, edits: 0, pasteEvents: 0, pastedChars: 0 });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("agents and provenance", async () => {
  const { VaultSync } = await import("../vaultSync");
  const { computeBlankScore } = await import("../blankScore");
  const { diffHunks } = await import("../noteFile");

  it("diffs narrowly", () => {
    const h = diffHunks("hello world\nsecond\n", "hello brave world\nsecond\n");
    expect(h.length).toBe(1);
    expect(h[0].newEnd - h[0].newStart).toBe(6);
    expect(h[0].oldEnd - h[0].oldStart).toBe(0);
    expect(diffHunks("আমি লিখি\n", "আমি নিজে লিখি\n").map((x) => "আমি নিজে লিখি\n".slice(x.newStart, x.newEnd).trim())).toEqual(["নিজে"]);
    expect(diffHunks("a\nb\nc\n", "a\nX\nb\nc\nY\n").length).toBe(2);
  });

  it("marks agent text, keeps notes clean, survives fresh devices", async () => {
    const a = new VaultSync();
    await a.start();
    const p = a.createNote("Journal.md");
    a.updateNote(p, "hello world\n", S(12), []);
    await a.flushNow();
    expect(db.get("Journal.md")!.body).toBe("hello world\n"); // pure markdown
    expect(db.get("Journal.md")!.record).toContain('"body":"hello world\\n"'); // record saved alongside

    agentWrite("Journal.md", "hello brave world\nAI summary line\n");
    await a.refresh();
    const note = a.getSnapshot().notes[p];
    expect(note.body).toBe("hello brave world\nAI summary line\n");
    const marked = note.pasteRanges.map((r) => note.body.slice(r.start, r.start + r.length).trim());
    expect(marked).toEqual(["brave", "AI summary line"]);
    expect(note.stats.pastedChars).toBe(22);
    expect(note.stats.keystrokes).toBe(12);
    const score = computeBlankScore(note.stats, note.body.length).score;
    expect(score).toBeLessThan(40);
    expect(a.hasUnsavedChanges()).toBe(false); // nothing written back on load

    const c = new VaultSync(); await c.start(); await c.ensureLoaded(p);
    expect(c.getSnapshot().notes[p].pasteRanges).toEqual(note.pasteRanges);

    // user types over the agent's sentence -> record catches up, text stays clean
    a.updateNote(p, "hello world\nmy own words\n", { ...note.stats, keystrokes: 25, edits: 3, pastedChars: 0 }, []);
    await a.flushNow();
    expect(db.get("Journal.md")!.body).toBe("hello world\nmy own words\n");
    const d = new VaultSync(); await d.start(); await d.ensureLoaded(p);
    expect(d.getSnapshot().notes[p].pasteRanges).toEqual([]);

    // agent-created note: all external
    agentWrite("Inbox/From agent.md", "# Summary\nstuff\n");
    await a.refresh();
    await a.ensureLoaded("Inbox/From agent.md");
    expect(a.getSnapshot().notes["Inbox/From agent.md"].pasteRanges).toEqual([{ start: 0, length: 16 }]);

    // agent edits while user has unsaved edits -> conflict copy, nothing lost
    a.updateNote(p, "hello world\nmy own words, more\n", S(30), []);
    agentWrite("Journal.md", "hello world\nmy own words\n- agent bullet\n");
    await a.flushNow().catch(() => {}); await tick(); await a.flushNow();
    const notes = a.getSnapshot().notes;
    expect(notes[p].body).toContain("agent bullet");
    expect(Object.values(notes).some((x) => x.path.includes("conflict") && x.body.includes("more"))).toBe(true);

    // rename keeps text and record together
    const record = db.get("Journal.md")!.record;
    await a.renameNote(p, "Diary.md");
    expect(db.get("Diary.md")!.record).toBe(record);
    expect(db.has("Journal.md")).toBe(false);
    await a.deleteNote("Diary.md");
    expect(db.has("Diary.md")).toBe(false);
  });

  it("migrates v1 notes to clean markdown", async () => {
    agentWrite("Old.md", '---\nstartblank: {"v":1,"keystrokes":5,"edits":0,"pasteEvents":0,"pastedChars":0,"pasted":[]}\n---\nhello');
    const a = new VaultSync(); await a.start(); await a.ensureLoaded("Old.md"); await tick(); await a.flushNow();
    expect(db.get("Old.md")!.body).toBe("hello");
    expect(db.get("Old.md")!.record).not.toBeNull();
    expect(a.getSnapshot().notes["Old.md"].stats.keystrokes).toBe(5);
    expect(a.getSnapshot().notes["Old.md"].pasteRanges).toEqual([]);
  });
});
