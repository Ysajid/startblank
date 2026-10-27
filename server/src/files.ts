import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Each account's vault is a plain folder: <VAULT_ROOT>/<user id>/. Notes are
// stored under their real names, so the folder is as usable by agents and
// scripts on this machine as it is by the app.

export class PathError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class PreconditionError extends Error {}

// Where in-flight writes are staged before being renamed into place. It is a
// dot-folder, so the app never lists it as notes.
const TMP_DIR = ".startblank/tmp";

const MAX_SEGMENT_BYTES = 255;

// Vault-relative path ("Ideas/On walking.md") -> absolute path inside the
// user's folder. Rejects anything that could step outside it.
export function resolveInVault(userId: string, vaultPath: unknown): string {
  if (typeof vaultPath !== "string" || vaultPath === "") throw new PathError("path required");
  if (vaultPath.includes("\0") || vaultPath.includes("\\")) throw new PathError("invalid character in path");
  const segments = vaultPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new PathError("invalid path segment");
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) throw new PathError("name too long");
  }
  const root = userRoot(userId);
  const full = path.join(root, ...segments);
  if (!full.startsWith(root + path.sep)) throw new PathError("path escapes vault");
  return full;
}

export function userRoot(userId: string): string {
  return path.join(path.resolve(config.vaultRoot), userId);
}

// Symlinks could point anywhere on the machine; the vault never follows them.
async function assertNoSymlinks(userId: string, full: string): Promise<void> {
  const root = userRoot(userId);
  let current = full;
  while (current.startsWith(root + path.sep)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new PathError("symlinks are not allowed");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    current = path.dirname(current);
  }
}

// Changes whenever the file's content does, without reading it: nanosecond
// modification time plus size.
function etagOf(stat: { mtimeNs: bigint; size: bigint }): string {
  return `${stat.mtimeNs.toString(36)}-${stat.size.toString(36)}`;
}

export async function etag(userId: string, vaultPath: string): Promise<string | null> {
  const full = resolveInVault(userId, vaultPath);
  await assertNoSymlinks(userId, full);
  try {
    const stat = await fs.stat(full, { bigint: true });
    return stat.isFile() ? etagOf(stat) : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export interface ListedFile {
  path: string;
  etag: string;
}

export async function listFiles(userId: string): Promise<ListedFile[]> {
  const root = userRoot(userId);
  const out: ListedFile[] = [];
  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel === TMP_DIR) continue;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) {
        try {
          out.push({ path: rel, etag: etagOf(await fs.stat(path.join(dir, entry.name), { bigint: true })) });
        } catch {
          // deleted while we were listing
        }
      }
      // anything else (symlinks, sockets, …) is not part of the vault
    }
  }
  await walk(root, "");
  return out;
}

export async function readFile(userId: string, vaultPath: string): Promise<{ text: string; etag: string }> {
  const full = resolveInVault(userId, vaultPath);
  await assertNoSymlinks(userId, full);
  try {
    const handle = await fs.open(full, "r");
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new NotFoundError(vaultPath);
      return { text: await handle.readFile("utf8"), etag: etagOf(stat) };
    } finally {
      await handle.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EISDIR") {
      throw new NotFoundError(vaultPath);
    }
    throw e;
  }
}

// `expected`: undefined = write unconditionally; null = only if the file
// doesn't exist; a string = only if the file is still at that etag. This is
// what makes "nobody changed it since I last looked" a guarantee rather
// than a race.
export async function writeFile(
  userId: string,
  vaultPath: string,
  text: string,
  expected?: string | null
): Promise<string> {
  const full = resolveInVault(userId, vaultPath);
  return withUserLock(userId, async () => {
    await assertNoSymlinks(userId, full);
    if (expected !== undefined) {
      const current = await etag(userId, vaultPath);
      if (current !== expected) throw new PreconditionError(vaultPath);
    }
    const tmpDir = path.join(userRoot(userId), TMP_DIR);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write beside, then rename: readers (and agents) never see half a file.
    const tmp = path.join(tmpDir, randomUUID());
    await fs.writeFile(tmp, text, "utf8");
    try {
      await fs.rename(tmp, full);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return etagOf(await fs.stat(full, { bigint: true }));
  });
}

export async function moveFile(userId: string, from: string, to: string): Promise<void> {
  const fromFull = resolveInVault(userId, from);
  const toFull = resolveInVault(userId, to);
  await withUserLock(userId, async () => {
    await assertNoSymlinks(userId, fromFull);
    await assertNoSymlinks(userId, toFull);
    if ((await etag(userId, from)) === null) throw new NotFoundError(from);
    if ((await etag(userId, to)) !== null) throw new ConflictError(to);
    await fs.mkdir(path.dirname(toFull), { recursive: true });
    await fs.rename(fromFull, toFull);
    await removeEmptyParents(userId, fromFull);
  });
}

export async function removeFiles(userId: string, vaultPaths: string[]): Promise<void> {
  const fulls = vaultPaths.map((p) => resolveInVault(userId, p));
  await withUserLock(userId, async () => {
    for (const full of fulls) {
      await assertNoSymlinks(userId, full);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      await fs.rm(full);
      await removeEmptyParents(userId, full);
    }
  });
}

// Deleting or moving the last note out of a folder shouldn't leave an empty
// directory behind (empty folders the user wants are kept by a .keep file).
async function removeEmptyParents(userId: string, full: string): Promise<void> {
  const root = userRoot(userId);
  for (let dir = path.dirname(full); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return; // not empty (or already gone)
    }
  }
}

// Writes, moves and deletes for one account run one at a time, so an etag
// check and the write it guards can't interleave with another request.
const locks = new Map<string, Promise<unknown>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  locks.set(userId, settled);
  settled.then(() => {
    if (locks.get(userId) === settled) locks.delete(userId);
  });
  return run;
}
