import { describe, it, expect, vi, beforeAll } from "vitest";

const server = new Map<string, { text: string; etag: string }>();
let n = 0;
let downloads = 0;
const indexed: string[] = [];
vi.mock("../searchApi", () => ({
  requestIndex: (op: string, paths: string[]) => paths.forEach((p) => indexed.push(`${op}:${p}`)),
}));
vi.mock("../vaultStorage", () => ({
  FOLDER_MARKER: ".keep",
  listVault: async (uid: string) => [...server].filter(([k]) => k.startsWith(uid + "/")).map(([k, v]) => ({ path: k.slice(uid.length + 1), etag: v.etag })),
  readFile: async (uid: string, p: string) => { downloads++; const f = server.get(`${uid}/${p}`); if (!f) throw new Error("404"); return f.text; },
  remoteEtag: async (uid: string, p: string) => server.get(`${uid}/${p}`)?.etag ?? null,
  writeFile: async (uid: string, p: string, text: string) => { server.set(`${uid}/${p}`, { text, etag: `e${++n}` }); },
  moveFile: async (uid: string, a: string, b: string) => { const f = server.get(`${uid}/${a}`)!; server.delete(`${uid}/${a}`); server.set(`${uid}/${b}`, f); },
  removeFiles: async (uid: string, ps: string[]) => { ps.forEach((p) => server.delete(`${uid}/${p}`)); },
}));

beforeAll(() => { (globalThis as any).window = globalThis; });
const S = (k: number) => ({ keystrokes: k, edits: 0, pasteEvents: 0, pastedChars: 0 });

describe("VaultSync across two devices", async () => {
  const { VaultSync } = await import("../vaultSync");
  it("syncs, detects conflicts, renames", async () => {
    const a = new VaultSync("u1"), b = new VaultSync("u1");
    await a.start();
    const p = a.createNote("Ideas/Note.md");
    a.updateNote(p, "hello", S(5), []);
    await a.flushNow();
    expect(server.get("u1/Ideas/Note.md")!.text).toContain("hello");

    const before = downloads;
    await b.start();
    // listed, but not downloaded until opened
    expect(b.getSnapshot().notes[p].loaded).toBe(false);
    expect(downloads).toBe(before);
    await b.ensureLoaded(p);
    expect(b.getSnapshot().notes[p].loaded).toBe(true);
    expect(b.getSnapshot().notes[p].body).toBe("hello");
    expect(b.getSnapshot().notes[p].stats.keystrokes).toBe(5);

    b.updateNote(p, "hello from b", S(12), []);
    await b.flushNow();
    await a.refresh();
    expect(a.getSnapshot().notes[p].body).toBe("hello from b");
    expect(a.getSnapshot().versions[p]).toBe(1);

    // concurrent edits: b saves, a has unsaved edits then saves -> conflict copy
    b.updateNote(p, "b wins name", S(1), []);
    await b.flushNow();
    a.updateNote(p, "a local edit", S(2), []);
    await a.flushNow().catch(() => {});
    await a.flushNow();
    const notesA = a.getSnapshot().notes;
    expect(notesA[p].body).toBe("b wins name");
    const copy = Object.keys(notesA).find((k) => k.includes("conflict"))!;
    expect(notesA[copy].body).toBe("a local edit");
    expect(server.has(`u1/${copy}`)).toBe(true);
    expect(a.getSnapshot().notice).toMatch(/changed somewhere else/);

    // own save doesn't look like a remote change
    a.updateNote(p, "b wins name!", S(3), []);
    await a.flushNow();
    const v = a.getSnapshot().versions[p];
    await a.refresh();
    expect(a.getSnapshot().versions[p]).toBe(v);
    expect(a.hasUnsavedChanges()).toBe(false);

    // saves ask for the note to be indexed
    expect(indexed).toContain(`upsert:${p}`);

    // a note nobody has opened changing elsewhere costs no download
    const unopened = b.createNote("Unopened.md");
    b.updateNote(unopened, "x", S(1), []);
    await b.flushNow();
    await a.refresh();
    expect(a.getSnapshot().notes[unopened].loaded).toBe(false);
    b.updateNote(unopened, "xy", S(2), []);
    await b.flushNow();
    const beforeRefresh = downloads;
    await a.refresh();
    expect(downloads).toBe(beforeRefresh);
    await a.deleteNote(unopened);
    expect(server.has("u1/Unopened.md")).toBe(false);
    expect(server.has("u1/.startblank/record/Unopened.md.json")).toBe(false);
    expect(indexed).toContain("delete:Unopened.md");

    // folder rename and delete propagate
    await a.renameFolder("Ideas", "Thoughts");
    await b.refresh();
    expect(Object.keys(b.getSnapshot().notes).every((k) => k.startsWith("Thoughts/"))).toBe(true);
    await a.deleteNote("Thoughts/Note.md");
    await b.refresh();
    expect(b.getSnapshot().notes["Thoughts/Note.md"]).toBeUndefined();

    // empty folders persist via marker
    await a.createFolder("Empty");
    await b.refresh();
    expect(b.getSnapshot().folders).toContain("Empty");
    expect(b.getSnapshot().status).toBe("synced");
  });
});
