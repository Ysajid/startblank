import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { agentWrite, counters, db, folders, hooks, reset } from "./fakeVault";

vi.mock("../vaultStorage", () => import("./fakeVault"));

beforeAll(() => {
  (globalThis as any).window = globalThis;
});
beforeEach(reset);

const S = (k: number) => ({ keystrokes: k, edits: 0, pasteEvents: 0, pastedChars: 0 });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("VaultSync across two devices", async () => {
  const { VaultSync } = await import("../vaultSync");

  it("syncs, detects conflicts, renames", async () => {
    const a = new VaultSync(), b = new VaultSync();
    await a.start();
    const p = a.createNote("Ideas/Note.md");
    a.updateNote(p, "hello", S(5), []);
    await a.flushNow();
    expect(db.get(p)!.body).toBe("hello");
    expect(db.get(p)!.record).toContain('"keystrokes":5'); // saved with its text

    const before = counters.reads;
    await b.start();
    // listed, but not downloaded until opened
    expect(b.getSnapshot().notes[p].loaded).toBe(false);
    expect(counters.reads).toBe(before);
    await b.ensureLoaded(p);
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
    await tick();
    await a.flushNow();
    const notesA = a.getSnapshot().notes;
    expect(notesA[p].body).toBe("b wins name");
    const copy = Object.keys(notesA).find((k) => k.includes("conflict"))!;
    expect(notesA[copy].body).toBe("a local edit");
    expect(db.get(copy)!.body).toBe("a local edit");
    expect(a.getSnapshot().notice).toMatch(/changed somewhere else/);

    // own save doesn't look like a remote change
    a.updateNote(p, "b wins name!", S(3), []);
    await a.flushNow();
    const v = a.getSnapshot().versions[p];
    await a.refresh();
    expect(a.getSnapshot().versions[p]).toBe(v);
    expect(a.hasUnsavedChanges()).toBe(false);

    // something writes at the very moment we save: the server refuses ours,
    // and we keep both versions instead of overwriting
    a.updateNote(p, "my careful edit", S(4), []);
    hooks.beforeSave = () => agentWrite(p, "sneaky agent write");
    await a.flushNow();
    expect(db.get(p)!.body).toBe("sneaky agent write");
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
    const beforeRefresh = counters.reads;
    await a.refresh();
    expect(counters.reads).toBe(beforeRefresh);
    await a.deleteNote(unopened);
    expect(db.has(unopened)).toBe(false);

    // folder rename (one step on the server) and delete propagate
    await a.createFolder("Ideas/Empty");
    await a.renameFolder("Ideas", "Thoughts");
    expect([...db.keys()].some((k) => k.startsWith("Ideas/"))).toBe(false);
    expect(folders.has("Thoughts/Empty")).toBe(true);
    expect(a.getSnapshot().notes["Thoughts/Note.md"].body).toBe("sneaky agent write");
    await b.refresh();
    expect(Object.keys(b.getSnapshot().notes).filter((k) => !k.includes("conflict")).every((k) => k.startsWith("Thoughts/"))).toBe(true);
    expect(b.getSnapshot().folders).toContain("Thoughts/Empty");
    await a.deleteNote("Thoughts/Note.md");
    await b.refresh();
    expect(b.getSnapshot().notes["Thoughts/Note.md"]).toBeUndefined();
    await a.deleteFolder("Thoughts");
    await b.refresh();
    expect(b.getSnapshot().folders).not.toContain("Thoughts/Empty");
    expect(b.getSnapshot().status).toBe("synced");
  });

  it("recreates a note deleted elsewhere while it was being edited", async () => {
    const a = new VaultSync();
    await a.start();
    const p = a.createNote("Draft.md");
    a.updateNote(p, "first", S(5), []);
    await a.flushNow();
    a.updateNote(p, "first and more", S(14), []);
    db.delete(p);
    await a.flushNow();
    await tick();
    await a.flushNow();
    expect(db.get(p)!.body).toBe("first and more");
  });
});

describe("VaultSync.importNotes", async () => {
  const { VaultSync } = await import("../vaultSync");

  it("saves imported notes, numbering names that are taken, as not written here", async () => {
    const a = new VaultSync();
    await a.start();
    a.createNote("Ideas/Walk.md");
    const created = a.importNotes([
      { path: "Ideas/Walk.md", body: "imported" },
      { path: "Inbox.md", body: "hi" },
    ]);
    expect(created).toEqual(["Ideas/Walk 2.md", "Inbox.md"]);
    await a.flushNow();
    expect(db.get("Ideas/Walk 2.md")!.body).toBe("imported");
    expect(db.get("Inbox.md")!.record).toContain('"pastedChars":2');
  });
});
