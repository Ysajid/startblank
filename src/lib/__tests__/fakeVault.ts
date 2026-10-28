// An in-memory stand-in for the vault server (src/lib/vaultStorage.ts),
// with the same rules: versioned saves that refuse to overwrite a newer
// version, folders as path prefixes.

export class NoteChangedError extends Error {}
export class NotFoundError extends Error {}

export const db = new Map<string, { body: string; record: string | null; version: number }>();
export const folders = new Set<string>();
export const counters = { reads: 0 };
// Runs once just before the next save is applied, to simulate something
// else writing in between.
export const hooks: { beforeSave: null | (() => void) } = { beforeSave: null };

export function reset() {
  db.clear();
  folders.clear();
  counters.reads = 0;
  hooks.beforeSave = null;
}

// What an agent writing through the API does: change the text, leave the
// app's record as it was.
export function agentWrite(path: string, body: string) {
  const current = db.get(path);
  db.set(path, { body, record: current?.record ?? null, version: (current?.version ?? 0) + 1 });
}

const under = (p: string, folder: string) => p.startsWith(`${folder}/`);

export async function listVault() {
  return {
    notes: [...db].map(([path, n]) => ({ path, version: n.version })),
    folders: [...folders],
  };
}

export async function readNote(path: string) {
  counters.reads++;
  const note = db.get(path);
  if (!note) throw new NotFoundError(path);
  return { ...note };
}

export async function saveNote(path: string, body: string, record: string | null, baseVersion: number | null) {
  const hook = hooks.beforeSave;
  hooks.beforeSave = null;
  hook?.();
  const current = db.get(path);
  if (baseVersion === null ? current : current?.version !== baseVersion) throw new NoteChangedError(path);
  const version = (current?.version ?? 0) + 1;
  db.set(path, { body, record, version });
  return version;
}

export async function moveNote(from: string, to: string) {
  const note = db.get(from);
  if (!note) throw new NotFoundError(from);
  if (db.has(to)) throw new Error("exists");
  db.delete(from);
  db.set(to, note);
}

export async function deleteNotes(paths: string[]) {
  for (const p of paths) db.delete(p);
}

export async function createFolder(path: string) {
  folders.add(path);
}

export async function moveFolder(from: string, to: string) {
  let moved = 0;
  for (const [p, n] of [...db]) {
    if (!under(p, from)) continue;
    db.delete(p);
    db.set(`${to}${p.slice(from.length)}`, n);
    moved++;
  }
  for (const f of [...folders]) {
    if (f !== from && !under(f, from)) continue;
    folders.delete(f);
    folders.add(`${to}${f.slice(from.length)}`);
    moved++;
  }
  if (moved === 0) throw new NotFoundError(from);
}

export async function deleteFolder(path: string) {
  for (const p of [...db.keys()]) if (under(p, path)) db.delete(p);
  for (const f of [...folders]) if (f === path || under(f, path)) folders.delete(f);
}

export async function searchNotes() {
  return [];
}

export async function fetchBacklinks() {
  return [];
}
