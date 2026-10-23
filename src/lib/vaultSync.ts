import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PasteRange } from "./provenance";
import type { WritingStats } from "../types";
import { parseNoteFile, serializeNoteFile, type NoteContent } from "./noteFile";
import {
  FOLDER_MARKER,
  listVault,
  moveFile,
  readFile,
  remoteEtag,
  removeFiles,
  writeFile,
} from "./vaultStorage";

export interface Note extends NoteContent {
  path: string;
  dirty: boolean;
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
  // The file text as last seen on the server (null: not on the server yet)
  // and its etag — what a save compares against to detect that another
  // device changed the file in the meantime.
  base: string | null;
  etag: string | null;
  dirty: boolean;
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
  private stopped = false;

  constructor(private userId: string) {
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
      notes[path] = { path, body: e.body, stats: e.stats, pasteRanges: e.pasteRanges, dirty: e.dirty };
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

  private fromText(text: string, etag: string | null): Entry {
    return { ...parseNoteFile(text), base: text, etag, dirty: false };
  }

  private replaceFromServer(path: string, text: string, etag: string) {
    const previous = this.entries.get(path);
    window.clearTimeout(previous?.timer);
    this.entries.set(path, this.fromText(text, etag));
    this.versions[path] = (this.versions[path] ?? 0) + 1;
  }

  private async pull() {
    const files = await listVault(this.userId);
    const remote = new Map<string, string>();
    const folders = new Set<string>();
    for (const file of files) {
      if (file.path.endsWith(`/${FOLDER_MARKER}`)) folders.add(parentOf(file.path));
      else if (file.path.toLowerCase().endsWith(NOTE_EXT)) remote.set(file.path, file.etag);
    }

    const changed = [...remote].filter(([path, etag]) => this.entries.get(path)?.etag !== etag);
    const texts = await mapLimit(changed, DOWNLOAD_CONCURRENCY, ([path]) => readFile(this.userId, path));

    changed.forEach(([path, etag], i) => {
      const text = texts[i];
      const entry = this.entries.get(path);
      if (!entry) {
        this.entries.set(path, this.fromText(text, etag));
      } else if (text === entry.base) {
        entry.etag = etag; // our own save, now with its etag
      } else if (!entry.dirty) {
        this.replaceFromServer(path, text, etag);
      } else {
        this.keepBoth(path, text, etag);
      }
    });

    for (const [path, entry] of [...this.entries]) {
      if (remote.has(path) || entry.base === null) continue;
      if (entry.dirty) {
        // Deleted elsewhere while being edited here: the edits win, so
        // treat it as a brand-new file on the next save.
        entry.base = null;
        entry.etag = null;
      } else {
        this.entries.delete(path);
      }
    }

    this.folders = folders;
  }

  // Both this device and another changed the same note. Nothing is thrown
  // away: the server's version takes the original name, ours is saved next
  // to it as a conflict copy.
  private keepBoth(path: string, remoteText: string, etag: string) {
    const local = this.entries.get(path)!;
    const copyPath = this.uniquePath(
      `${path.slice(0, -NOTE_EXT.length)} (conflict ${timestamp()})${NOTE_EXT}`
    );
    this.entries.set(copyPath, {
      body: local.body,
      stats: local.stats,
      pasteRanges: local.pasteRanges,
      base: null,
      etag: null,
      dirty: true,
    });
    this.replaceFromServer(path, remoteText, etag);
    this.scheduleSave(copyPath, 0);
    this.notice = `“${noteTitle(path)}” was also changed on another device. Your version was kept as “${noteTitle(copyPath)}”.`;
  }

  uniquePath(path: string): string {
    if (!this.entries.has(path)) return path;
    const stem = path.slice(0, -NOTE_EXT.length);
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}${NOTE_EXT}`;
      if (!this.entries.has(candidate)) return candidate;
    }
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
    const text = serializeNoteFile(entry);

    const current = await remoteEtag(this.userId, path);
    if (current !== null && current !== entry.etag) {
      const remoteText = await readFile(this.userId, path);
      if (remoteText !== entry.base) {
        this.keepBoth(path, remoteText, current);
        return;
      }
    }

    await writeFile(this.userId, path, text);
    entry.base = text;
    entry.etag = await remoteEtag(this.userId, path);
    // Typing that happened while the upload was in flight still needs saving.
    entry.dirty = serializeNoteFile(entry) !== text;
    if (entry.dirty) this.scheduleSave(path);
  }

  flushAll() {
    for (const [path, entry] of this.entries) {
      if (entry.dirty) this.scheduleSave(path, 0);
    }
  }

  // Saves everything right now and resolves once the server has it (or
  // rejects if it couldn't) — used before signing out.
  async flushNow() {
    for (const [path, entry] of this.entries) {
      window.clearTimeout(entry.timer);
      if (entry.dirty) this.enqueue(() => this.flush(path)).catch(() => undefined);
    }
    await this.queue;
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
    this.entries.set(target, {
      body: content?.body ?? "",
      stats: content?.stats ?? { keystrokes: 0, edits: 0, pasteEvents: 0, pastedChars: 0 },
      pasteRanges: content?.pasteRanges ?? [],
      base: null,
      etag: null,
      dirty: true,
    });
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
    if (entry.dirty && entry.base !== null) await this.flush(from);
    window.clearTimeout(entry.timer);
    if (entry.base !== null) await moveFile(this.userId, from, to);
    this.entries.delete(from);
    this.entries.set(to, entry);
    if (entry.dirty) this.scheduleSave(to, 0);
  }

  deleteNote(path: string) {
    return this.enqueue(async () => {
      const entry = this.entries.get(path);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      if (entry.base !== null) await removeFiles(this.userId, [path]);
      this.entries.delete(path);
    });
  }

  createFolder(path: string) {
    return this.enqueue(async () => {
      await writeFile(this.userId, `${path}/${FOLDER_MARKER}`, "");
      this.folders.add(path);
    });
  }

  renameFolder(from: string, to: string) {
    return this.enqueue(async () => {
      if (this.pathExists(to)) throw new Error("Something with that name already exists.");
      for (const path of [...this.entries.keys()]) {
        if (isUnder(path, from)) await this.moveOne(path, `${to}${path.slice(from.length)}`);
      }
      for (const folder of [...this.folders]) {
        if (folder === from || isUnder(folder, from)) {
          const moved = `${to}${folder.slice(from.length)}`;
          await moveFile(this.userId, `${folder}/${FOLDER_MARKER}`, `${moved}/${FOLDER_MARKER}`);
          this.folders.delete(folder);
          this.folders.add(moved);
        }
      }
    });
  }

  deleteFolder(path: string) {
    return this.enqueue(async () => {
      const notes = [...this.entries.keys()].filter((p) => isUnder(p, path));
      const markers = [...this.folders]
        .filter((f) => f === path || isUnder(f, path))
        .map((f) => `${f}/${FOLDER_MARKER}`);
      const onServer = notes.filter((p) => this.entries.get(p)!.base !== null);
      await removeFiles(this.userId, [...onServer, ...markers]);
      for (const p of notes) {
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
  const vault = useMemo(() => new VaultSync(userId), [userId]);
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
