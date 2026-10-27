import { describe, it, expect, vi, beforeAll } from "vitest";

const server = new Map<string, { text: string; etag: string }>();
let n = 0;
let downloads = 0;
// Runs once just before the next write is applied, to simulate something
// else writing in between the app's check and its write.
let beforeNextWrite: (() => void) | null = null;
vi.mock("../vaultStorage", () => {
  class FileChangedError extends Error {}
  const U = "u1/";
  return {
    FOLDER_MARKER: ".keep",
    FileChangedError,
    listVault: async () => [...server].filter(([k]) => k.startsWith(U)).map(([k, v]) => ({ path: k.slice(U.length), etag: v.etag })),
    readFile: async (p: string) => { downloads++; const f = server.get(U + p); if (!f) throw new Error("404"); return f.text; },
    remoteEtag: async (p: string) => server.get(U + p)?.etag ?? null,
    writeFile: async (p: string, text: string, expected?: string | null) => {
      const hook = beforeNextWrite; beforeNextWrite = null; hook?.();
      if (expected !== undefined && (server.get(U + p)?.etag ?? null) !== expected) throw new FileChangedError(p);
      const etag = `e${++n}`; server.set(U + p, { text, etag }); return etag;
    },
    moveFile: async (a: string, b: string) => { const f = server.get(U + a)!; server.delete(U + a); server.set(U + b, f); },
    removeFiles: async (ps: string[]) => { ps.forEach((p) => server.delete(U + p)); },
  };
});

beforeAll(() => { (globalThis as any).window = globalThis; });
const S = (k: number) => ({ keystrokes: k, edits: 0, pasteEvents: 0, pastedChars: 0 });

describe("VaultSync across two devices", async () => {
  const { VaultSync } = await import("../vaultSync");
  it("syncs, detects conflicts, renames", async () => {
    const a = new VaultSync(), b = new VaultSync();
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

    // something writes between the app's check and its write: the server
    // refuses, and the retry keeps both versions instead of overwriting
    a.updateNote(p, "my careful edit", S(4), []);
    let raced = false;
    const realHook = () => { server.set("u1/" + p, { text: "sneaky agent write", etag: `e${++n}` }); raced = true; };
    beforeNextWrite = () => { beforeNextWrite = realHook; }; // the record write goes first
    await a.flushNow().catch(() => {});
    expect(raced).toBe(true);
    expect(server.get("u1/" + p)!.text).toBe("sneaky agent write");
    await new Promise((r) => setTimeout(r, 5));
    await a.refresh();
    await a.flushNow();
    expect(a.getSnapshot().notes[p].body).toBe("sneaky agent write");
    expect(Object.values(a.getSnapshot().notes).some((x) => x.body === "my careful edit" && x.path.includes("conflict"))).toBe(true);

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
