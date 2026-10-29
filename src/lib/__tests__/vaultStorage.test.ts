import { describe, it, expect, vi, beforeEach } from "vitest";

// The calls vaultStorage makes to Supabase, and how it reads the answers —
// pinned against supabase/vault.sql's function names and arguments.
const calls: { kind: string; name: string; args?: unknown }[] = [];
let next: { data?: unknown; error?: { code?: string; message: string } | null } = {};

function query(table: string) {
  const chain: any = {
    select: (cols: string) => (calls.push({ kind: "select", name: table, args: cols }), chain),
    eq: (col: string, val: unknown) => (calls.push({ kind: "eq", name: col, args: val }), chain),
    in: (col: string, vals: unknown) => (calls.push({ kind: "in", name: col, args: vals }), Promise.resolve(next)),
    delete: () => (calls.push({ kind: "delete", name: table }), chain),
    upsert: (row: unknown, opts: unknown) => (calls.push({ kind: "upsert", name: table, args: [row, opts] }), Promise.resolve(next)),
    maybeSingle: () => Promise.resolve(next),
  };
  return chain;
}

vi.mock("../supabase", () => ({
  supabase: {
    rpc: (name: string, args: unknown) => (calls.push({ kind: "rpc", name, args }), Promise.resolve(next)),
    from: (table: string) => query(table),
  },
}));

const api = await import("../vaultStorage");

beforeEach(() => {
  calls.length = 0;
  next = { data: null, error: null };
});

describe("vaultStorage", () => {
  it("lists the vault with numeric versions", async () => {
    next = { data: { notes: [{ path: "a.md", version: "3" }], folders: ["F"] }, error: null };
    expect(await api.listVault()).toEqual({ notes: [{ path: "a.md", version: 3 }], folders: ["F"] });
    expect(calls).toEqual([{ kind: "rpc", name: "list_vault", args: undefined }]);
  });

  it("saves through save_note and treats null as 'changed first'", async () => {
    next = { data: 4, error: null };
    expect(await api.saveNote("a.md", "hi", "{}", 3)).toBe(4);
    expect(calls[0]).toEqual({
      kind: "rpc",
      name: "save_note",
      args: { p_path: "a.md", p_body: "hi", p_record: "{}", p_base_version: 3 },
    });
    next = { data: null, error: null };
    await expect(api.saveNote("a.md", "hi", null, null)).rejects.toBeInstanceOf(api.NoteChangedError);
  });

  it("reads one note by path, 404 when missing", async () => {
    next = { data: { body: "b", record: null, version: "2" }, error: null };
    expect(await api.readNote("a.md")).toEqual({ body: "b", record: null, version: 2 });
    expect(calls.slice(0, 2)).toEqual([
      { kind: "select", name: "notes", args: "body, record, version" },
      { kind: "eq", name: "path", args: "a.md" },
    ]);
    next = { data: null, error: null };
    await expect(api.readNote("gone.md")).rejects.toBeInstanceOf(api.NotFoundError);
  });

  it("maps database errors", async () => {
    next = { data: null, error: { code: "P0002", message: "note not found" } };
    await expect(api.moveNote("a.md", "b.md")).rejects.toBeInstanceOf(api.NotFoundError);
    next = { data: null, error: { code: "23505", message: "duplicate key" } };
    await expect(api.moveFolder("A", "B")).rejects.toBeInstanceOf(api.AlreadyExistsError);
    next = { data: null, error: { code: "42501", message: "permission denied" } };
    await expect(api.searchNotes("x")).rejects.toThrow("permission denied");
  });

  it("uses the right functions for folders, links and search", async () => {
    await api.createFolder("F");
    await api.moveFolder("F", "G");
    await api.deleteFolder("G");
    await api.deleteNotes(["a.md"]);
    await api.deleteNotes([]);
    await api.fetchBacklinks("a.md");
    await api.searchNotes("walk");
    expect(calls).toEqual([
      { kind: "upsert", name: "folders", args: [{ path: "F" }, { onConflict: "owner_id,path", ignoreDuplicates: true }] },
      { kind: "rpc", name: "move_folder", args: { p_from: "F", p_to: "G" } },
      { kind: "rpc", name: "delete_folder", args: { p_path: "G" } },
      { kind: "delete", name: "notes" },
      { kind: "in", name: "path", args: ["a.md"] },
      { kind: "rpc", name: "note_backlinks", args: { p_path: "a.md" } },
      { kind: "rpc", name: "search_notes", args: { p_query: "walk" } },
    ]);
  });
});
