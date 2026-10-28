import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PasteRange } from "./provenance";
import type { WritingStats } from "../types";
import { loadNote, serializeRecord, type NoteContent } from "./noteFile";
import {
  NoteChangedError,
  NotFoundError,
  createFolder,
  deleteFolder,
  deleteNotes,
  listVault,
  moveFolder,
  moveNote,
  readNote,
  saveNote,
  type StoredNote,
} from "./vaultStorage";

export interface Note extends NoteContent {
  path: string;
  dirty: boolean;
  // Notes are listed up front but downloaded only when opened; until then
  // body/stats are empty placeholders.
  loaded: boolean;
}

export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error";

export interface VaultSnapshot {
  status: SyncStatus;
  notes: Record<string, Note>;
  folders: string[];
  // Bumped when a note's text was replaced from the server, so an open
  // editor knows to reload instead of keeping what it had.
  versions: Record<string, number>;
  notice: string | null;
}

interface Entry extends NoteContent {
  // The note's text and record as last seen on the server (null: not saved
  // yet), and the version they belong to. A save names that version, so the
  // server refuses it if another device or an agent changed the note since.
  base: string | null;
  recordBase: string | null;
  version: number | null;
  dirty: boolean;
  loaded: boolean;
  timer?: number;
}

const SAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 5000;
const POLL_MS = 30_000;
const DOWNLOAD_CONCURRENCY = 6;

export const NOTE_EXT = ".md";

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function noteTitle(path: string): string {
  return baseName(path).replace(/\.md$/i, "");
}

function emptyStats(): WritingStats {
  return { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 };
}

// A note known from the vault listing that hasn't been downloaded yet.
function stub(version: number): Entry {
  return {
    body: "",
    stats: emptyStats(),
    pasteRanges: [],
    base: null,
    recordBase: null,
    version,
    dirty: false,
    loaded: false,
  };
}

function unsaved(content: NoteContent): Entry {
  return { ...content, base: null, recordBase: null, version: null, dirty: true, loaded: true };
}

// Whether the note exists on the server (as far as we know).
function onServer(entry: Entry): boolean {
  return entry.version !== null;
}

function isUnder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class VaultSync {
  private entries = new Map<string, Entry>();
  private folders = new Set<string>();
  private versions: Record<string, number> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private failed = false;
  private loaded = false;
  private notice: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: VaultSnapshot;
  private loading: Promise<void> | null = null;
  private opening = new Map<string, Promise<void>>();
  private stopped = false;

  constructor() {
    this.snapshot = this.buildSnapshot();
  }

  // ---- React plumbing -----------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): VaultSnapshot {
    const notes: Record<string, Note> = {};
    for (const [path, e] of this.entries) {
      notes[path] = { path, body: e.body, stats: e.stats, pasteRanges: e.pasteRanges, dirty: e.dirty, loaded: e.loaded };
    }
    const folders = new Set(this.folders);
    for (const path of this.entries.keys()) {
      for (let p = parentOf(path); p; p = parentOf(p)) folders.add(p);
    }
    let status: SyncStatus;
    if (!this.loaded) status = this.failed ? "error" : "loading";
    else if (this.failed) status = navigator.onLine ? "error" : "offline";
    else if (this.pending > 0 || [...this.entries.values()].some((e) => e.dirty)) status = "saving";
    else status = "synced";
    return {
      status,
      notes,
      folders: [...folders].sort(),
      versions: { ...this.versions },
      notice: this.notice,
    };
  }

  // Every server operation runs one at a time, so a background refresh can
  // never interleave with a save, a rename or a delete.
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    this.pending++;
    this.emit();
    const run = this.queue.then(op);
    this.queue = run.then(
      () => {
        this.pending--;
        this.failed = false;
        this.emit();
      },
      () => {
        this.pending--;
        this.failed = true;
        this.emit();
      }
    );
    return run;
  }

  // ---- Loading & pulling changes from other devices ----------------------

  start() {
    this.stopped = false;
    if (!this.loading) {
      this.loading = this.enqueue(async () => {
        await this.pull();
        this.loaded = true;
      }).catch(() => {
        this.loading = null; // let a later start() try again
      });
    }
    return this.loading;
  }

  refresh() {
    if (!this.loaded || this.stopped) return Promise.resolve();
    return this.enqueue(() => this.pull()).catch(() => undefined);
  }

  private build(path: string, stored: StoredNote): Entry {
    const { content, migrate } = loadNote(stored.body, stored.record);
    const entry: Entry = {
      ...content,
      base: stored.body,
      recordBase: stored.record,
      version: stored.version,
      dirty: migrate,
      loaded: true,
    };
    if (migrate) queueMicrotask(() => this.scheduleSave(path, 0));
    return entry;
  }

  private replaceFromServer(path: string, stored: StoredNote) {
    const previous = this.entries.get(path);
    window.clearTimeout(previous?.timer);
    this.entries.set(path, this.build(path, stored));
    this.versions[path] = (this.versions[path] ?? 0) + 1;
  }

  private async pull() {
    const listing = await listVault();
    const remote = new Map(listing.notes.map((n) => [n.path, n.version]));

    // New and unopened notes only need their versions; just the notes that
    // are open (downloaded) are re-fetched when they change.
    for (const [path, version] of remote) {
      const entry = this.entries.get(path);
      if (!entry) this.entries.set(path, stub(version));
      else if (!entry.loaded) entry.version = version;
    }

    const changed = [...remote].filter(([path, version]) => {
      const entry = this.entries.get(path)!;
      return entry.loaded && entry.version !== version;
    });
    const fetched = await mapLimit(changed, DOWNLOAD_CONCURRENCY, ([path]) =>
      readNote(path).catch((e) => {
        if (e instanceof NotFoundError) return null; // deleted since the listing
        throw e;
      })
    );

    changed.forEach(([path], i) => {
      const stored = fetched[i];
      const entry = this.entries.get(path)!;
      if (!stored) return;
      if (stored.body === entry.base && stored.record === entry.recordBase) {
        entry.version = stored.version; // nothing new for us
      } else if (!entry.dirty) {
        this.replaceFromServer(path, stored);
      } else if (stored.body !== entry.base) {
        this.keepBoth(path, stored);
      } else {
        // Only the record moved on while we have unsaved edits; our next
        // save replaces it.
        entry.recordBase = stored.record;
        entry.version = stored.version;
      }
    });

    for (const [path, entry] of [...this.entries]) {
      if (remote.has(path) || !onServer(entry)) continue;
      if (entry.dirty) {
        // Deleted elsewhere while being edited here: the edits win, so
        // treat it as a brand-new note on the next save.
        entry.base = null;
        entry.recordBase = null;
        entry.version = null;
      } else {
        this.entries.delete(path);
      }
    }

    this.folders = new Set(listing.folders);
  }

  // Both this device and something else (another device, an agent) changed
  // the same note. Nothing is thrown away: the server's version takes the
  // original name, ours is saved next to it as a conflict copy.
  private keepBoth(path: string, stored: StoredNote) {
    const local = this.entries.get(path)!;
    const copyPath = this.uniquePath(
      `${path.slice(0, -NOTE_EXT.length)} (conflict ${timestamp()})${NOTE_EXT}`
    );
    this.entries.set(copyPath, unsaved(local));
    this.replaceFromServer(path, stored);
    this.scheduleSave(copyPath, 0);
    this.notice = `“${noteTitle(path)}” was changed somewhere else while you were editing it. Your version was kept as “${noteTitle(copyPath)}”.`;
  }

  uniquePath(path: string): string {
    if (!this.entries.has(path)) return path;
    const stem = path.slice(0, -NOTE_EXT.length);
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}${NOTE_EXT}`;
      if (!this.entries.has(candidate)) return candidate;
    }
  }

  // Downloads a listed note (with its record) the first time it's opened.
  ensureLoaded(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry || entry.loaded) return Promise.resolve();
    let pending = this.opening.get(path);
    if (!pending) {
      pending = this.enqueue(async () => {
        const current = this.entries.get(path);
        if (!current || current.loaded) return;
        this.entries.set(path, this.build(path, await readNote(path)));
      }).finally(() => this.opening.delete(path));
      this.opening.set(path, pending);
    }
    return pending;
  }

  dismissNotice() {
    this.notice = null;
    this.emit();
  }

  // ---- Saving -------------------------------------------------------------

  private scheduleSave(path: string, delay = SAVE_DELAY_MS) {
    const entry = this.entries.get(path);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      this.enqueue(() => this.flush(path)).catch(() => this.scheduleSave(path, RETRY_DELAY_MS));
    }, delay);
  }

  private async flush(path: string) {
    const entry = this.entries.get(path);
    if (!entry || !entry.dirty) return;
    window.clearTimeout(entry.timer);
    const body = entry.body;
    const record = serializeRecord(entry);

    try {
      // Text and record in one write, only if the note is still at the
      // version we last saw.
      entry.version = await saveNote(path, body, record, entry.version);
      entry.base = body;
      entry.recordBase = record;
    } catch (e) {
      if (!(e instanceof NoteChangedError)) throw e;
      const stored = await readNote(path).catch((err) => {
        if (err instanceof NotFoundError) return null;
        throw err;
      });
      if (!stored) {
        // Deleted elsewhere: our edits win; save it as a new note.
        entry.base = entry.recordBase = null;
        entry.version = null;
      } else if (stored.body === entry.base) {
        // Same text (only the record moved on): save again on top of it.
        entry.version = stored.version;
        entry.recordBase = stored.record;
      } else {
        this.keepBoth(path, stored);
        return;
      }
      this.scheduleSave(path, 0);
      return;
    }
    // Typing that happened while the save was in flight still needs saving.
    entry.dirty = serializeRecord(entry) !== record;
    if (entry.dirty) this.scheduleSave(path);
  }

  flushAll() {
    for (const [path, entry] of this.entries) {
      if (entry.dirty) this.scheduleSave(path, 0);
    }
  }

  // Saves everything right now and resolves once the server has it (or
  // rejects if it couldn't) — used before signing out. A save can lead to
  // another (a conflict copy, a note deleted elsewhere being recreated), so
  // this runs a few passes.
  async flushNow() {
    for (let pass = 0; pass < 3 && this.hasUnsavedChanges(); pass++) {
      for (const [path, entry] of this.entries) {
        window.clearTimeout(entry.timer);
        if (entry.dirty) this.enqueue(() => this.flush(path)).catch(() => undefined);
      }
      await this.queue;
    }
    if (this.hasUnsavedChanges()) throw new Error("Some notes couldn't be saved.");
  }

  hasUnsavedChanges() {
    return [...this.entries.values()].some((e) => e.dirty);
  }

  // ---- Editing ------------------------------------------------------------

  updateNote(path: string, body: string, stats: WritingStats, pasteRanges: PasteRange[]) {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.body = body;
    entry.stats = { ...stats };
    entry.pasteRanges = pasteRanges;
    entry.dirty = true;
    this.scheduleSave(path);
    this.emit();
  }

  createNote(path: string, content?: NoteContent): string {
    const target = this.uniquePath(path);
    this.entries.set(target, unsaved(content ?? { body: "", stats: emptyStats(), pasteRanges: [] }));
    this.scheduleSave(target, 0);
    this.emit();
    return target;
  }

  pathExists(path: string): boolean {
    return this.entries.has(path) || this.snapshot.folders.includes(path);
  }

  renameNote(from: string, to: string) {
    return this.enqueue(async () => {
      if (from === to) return;
      if (this.entries.has(to)) throw new Error("A note with that name already exists.");
      await this.moveOne(from, to);
    });
  }

  private async moveOne(from: string, to: string) {
    const entry = this.entries.get(from);
    if (!entry) return;
    if (entry.dirty && onServer(entry)) await this.flush(from);
    window.clearTimeout(entry.timer);
    if (onServer(entry)) await moveNote(from, to);
    this.entries.delete(from);
    this.entries.set(to, entry);
    if (entry.dirty) this.scheduleSave(to, 0);
  }

  deleteNote(path: string) {
    return this.enqueue(async () => {
      const entry = this.entries.get(path);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      if (onServer(entry)) await deleteNotes([path]);
      this.entries.delete(path);
    });
  }

  createFolder(path: string) {
    return this.enqueue(async () => {
      await createFolder(path);
      this.folders.add(path);
    });
  }

  renameFolder(from: string, to: string) {
    return this.enqueue(async () => {
      if (this.pathExists(to)) throw new Error("Something with that name already exists.");
      const inside = [...this.entries.keys()].filter((p) => isUnder(p, from));
      for (const path of inside) {
        const entry = this.entries.get(path)!;
        if (entry.dirty && onServer(entry)) await this.flush(path);
      }
      // One step on the server for the whole folder…
      await moveFolder(from, to).catch((e) => {
        if (!(e instanceof NotFoundError)) throw e; // nothing of it saved yet
      });
      // …and the same rename locally.
      for (const path of inside) {
        const entry = this.entries.get(path)!;
        window.clearTimeout(entry.timer);
        const moved = `${to}${path.slice(from.length)}`;
        this.entries.delete(path);
        this.entries.set(moved, entry);
        if (entry.dirty) this.scheduleSave(moved, 0);
      }
      for (const folder of [...this.folders]) {
        if (folder === from || isUnder(folder, from)) {
          this.folders.delete(folder);
          this.folders.add(`${to}${folder.slice(from.length)}`);
        }
      }
    });
  }

  deleteFolder(path: string) {
    return this.enqueue(async () => {
      await deleteFolder(path);
      for (const p of [...this.entries.keys()]) {
        if (!isUnder(p, path)) continue;
        window.clearTimeout(this.entries.get(p)!.timer);
        this.entries.delete(p);
      }
      for (const f of [...this.folders]) {
        if (f === path || isUnder(f, path)) this.folders.delete(f);
      }
    });
  }

  stop() {
    this.stopped = true;
  }
}

export function useVault(userId: string) {
  // A fresh vault per account; the server works out whose from the token.
  const vault = useMemo(() => new VaultSync(), [userId]);
  const snapshot = useSyncExternalStore(vault.subscribe, vault.getSnapshot);

  useEffect(() => {
    vault.start();

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") vault.refresh();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") vault.flushAll();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!vault.hasUnsavedChanges()) return;
      vault.flushAll();
      event.preventDefault();
    };

    const poll = window.setInterval(refreshIfVisible, POLL_MS);
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      vault.stop();
    };
  }, [vault]);

  return { vault, snapshot };
}
