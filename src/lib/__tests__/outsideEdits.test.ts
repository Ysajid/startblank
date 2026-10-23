import { describe, it, expect, vi, beforeAll } from "vitest";

const server = new Map<string, { text: string; etag: string }>();
let n = 0;
vi.mock("../vaultStorage", () => ({
  FOLDER_MARKER: ".keep",
  listVault: async (uid: string) => [...server].filter(([k]) => k.startsWith(uid + "/")).map(([k, v]) => ({ path: k.slice(uid.length + 1), etag: v.etag })),
  readFile: async (uid: string, p: string) => { const f = server.get(`${uid}/${p}`); if (!f) throw new Error("404 " + p); return f.text; },
  remoteEtag: async (uid: string, p: string) => server.get(`${uid}/${p}`)?.etag ?? null,
  writeFile: async (uid: string, p: string, text: string) => { server.set(`${uid}/${p}`, { text, etag: `e${++n}` }); },
  moveFile: async (uid: string, a: string, b: string) => { const f = server.get(`${uid}/${a}`)!; server.delete(`${uid}/${a}`); server.set(`${uid}/${b}`, f); },
  removeFiles: async (uid: string, ps: string[]) => { ps.forEach((p) => server.delete(`${uid}/${p}`)); },
}));
beforeAll(() => { (globalThis as any).window = globalThis; });
const agentWrite = (p: string, text: string) => server.set(`u1/${p}`, { text, etag: `e${++n}` });
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

  it("marks agent text, keeps files clean, survives fresh devices", async () => {
    const a = new VaultSync("u1");
    await a.start();
    const p = a.createNote("Journal.md");
    a.updateNote(p, "hello world\n", S(12), []);
    await a.flushNow();
    expect(server.get("u1/Journal.md")!.text).toBe("hello world\n"); // pure markdown
    expect(server.has("u1/.startblank/record/Journal.md.json")).toBe(true);
    expect(Object.keys(a.getSnapshot().notes)).toEqual(["Journal.md"]); // record not shown as a note

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

    const c = new VaultSync("u1"); await c.start();
    expect(c.getSnapshot().notes[p].pasteRanges).toEqual(note.pasteRanges);

    // user types over the agent's sentence -> record catches up, file stays clean
    a.updateNote(p, "hello world\nmy own words\n", { ...note.stats, keystrokes: 25, edits: 3, pastedChars: 0 }, []);
    await a.flushNow();
    expect(server.get("u1/Journal.md")!.text).toBe("hello world\nmy own words\n");
    const d = new VaultSync("u1"); await d.start();
    expect(d.getSnapshot().notes[p].pasteRanges).toEqual([]);

    // agent-created note: all external
    agentWrite("Inbox/From agent.md", "# Summary\nstuff\n");
    await a.refresh();
    expect(a.getSnapshot().notes["Inbox/From agent.md"].pasteRanges).toEqual([{ start: 0, length: 16 }]);

    // agent edits while user has unsaved edits -> conflict copy, nothing lost
    a.updateNote(p, "hello world\nmy own words, more\n", S(30), []);
    agentWrite("Journal.md", "hello world\nmy own words\n- agent bullet\n");
    await a.flushNow().catch(() => {}); await tick(); await a.flushNow();
    const notes = a.getSnapshot().notes;
    expect(notes[p].body).toContain("agent bullet");
    expect(Object.values(notes).some((x) => x.path.includes("conflict") && x.body.includes("more"))).toBe(true);

    // rename moves the record too
    await a.renameNote(p, "Diary.md");
    expect(server.has("u1/.startblank/record/Diary.md.json")).toBe(true);
    expect(server.has("u1/.startblank/record/Journal.md.json")).toBe(false);
    await a.deleteNote("Diary.md");
    expect(server.has("u1/.startblank/record/Diary.md.json")).toBe(false);
  });

  it("migrates v1 notes to clean markdown", async () => {
    server.clear();
    agentWrite("Old.md", '---\nstartblank: {"v":1,"keystrokes":5,"edits":0,"pasteEvents":0,"pastedChars":0,"pasted":[]}\n---\nhello');
    const a = new VaultSync("u1"); await a.start(); await tick(); await a.flushNow();
    expect(server.get("u1/Old.md")!.text).toBe("hello");
    expect(a.getSnapshot().notes["Old.md"].stats.keystrokes).toBe(5);
    expect(a.getSnapshot().notes["Old.md"].pasteRanges).toEqual([]);
  });
});
