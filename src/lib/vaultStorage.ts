import { supabase } from "./supabase";

// Notes are files, not rows: each user's vault is a folder in the private
// `vaults` Storage bucket, `<user id>/<note path>`, guarded by the policies
// in supabase/vaults.sql so nobody can reach another user's folder.
//
// Paths the app works with are vault-relative ("Ideas/On walking.md").
// Storage only accepts a narrow ASCII set in object keys, so anything else
// (accents, non-Latin scripts, `#`, `[`, …) is stored quoted-printable
// style — "Café" becomes "Caf=C3=A9" — and decoded on the way back.

const BUCKET = "vaults";

// Marks a folder that has no notes in it yet (Storage has no real folders).
export const FOLDER_MARKER = ".keep";

export interface RemoteFile {
  path: string;
  etag: string;
}

const SAFE_CHAR = /[A-Za-z0-9 _\-.()!,'&@;+$]/;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function encodeSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (SAFE_CHAR.test(ch)) {
      out += ch;
    } else {
      for (const byte of utf8.encode(ch)) out += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function decodeSegment(segment: string): string {
  return segment.replace(/(?:=[0-9A-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return utf8Decoder.decode(bytes);
  });
}

function toKey(userId: string, path: string): string {
  return `${userId}/${path.split("/").map(encodeSegment).join("/")}`;
}

function fromKey(userId: string, key: string): string {
  return key
    .slice(userId.length + 1)
    .split("/")
    .map(decodeSegment)
    .join("/");
}

function normalizeEtag(etag: string | undefined | null): string {
  return (etag ?? "").replace(/^W\//, "").replace(/"/g, "");
}

const PAGE = 1000;

// Storage's list() is one level deep, so walk the tree folder by folder.
export async function listVault(userId: string): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  const queue = [userId];
  while (queue.length > 0) {
    const prefix = queue.shift()!;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      for (const entry of data) {
        const key = `${prefix}/${entry.name}`;
        if (entry.id === null) queue.push(key);
        else files.push({ path: fromKey(userId, key), etag: normalizeEtag(entry.metadata?.eTag) });
      }
      if (data.length < PAGE) break;
    }
  }
  return files;
}

export async function readFile(userId: string, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).download(toKey(userId, path));
  if (error) throw error;
  return data.text();
}

// The etag of the file as it is on the server right now, or null if it
// doesn't exist — the check that keeps one device from silently
// overwriting what another just saved.
export async function remoteEtag(userId: string, path: string): Promise<string | null> {
  const key = toKey(userId, path);
  const { data, error } = await supabase.storage.from(BUCKET).info(key);
  if (!error) return normalizeEtag(data.etag ?? data.metadata?.eTag);
  // info() fails the same way for "missing" and "network down"; tell them apart.
  // (exists() reports a 404 as data: false *with* an error attached.)
  const { data: exists } = await supabase.storage.from(BUCKET).exists(key);
  if (exists === false) return null;
  throw error;
}

export async function writeFile(userId: string, path: string, text: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).upload(toKey(userId, path), text, {
    upsert: true,
    // Never let a CDN or browser cache hand another device a stale copy.
    cacheControl: "0",
    contentType: "text/markdown; charset=utf-8",
  });
  if (error) throw error;
}

export async function moveFile(userId: string, from: string, to: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).move(toKey(userId, from), toKey(userId, to));
  if (error) throw error;
}

export async function removeFiles(userId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths.map((p) => toKey(userId, p)));
  if (error) throw error;
}
