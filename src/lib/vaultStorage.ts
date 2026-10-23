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

// One query for the whole vault (see list_vault_files() in
// supabase/search.sql), instead of walking it folder by folder.
export async function listVault(userId: string): Promise<RemoteFile[]> {
  const { data, error } = await supabase.rpc("list_vault_files");
  if (error) throw error;
  return (data as { name: string; etag: string }[])
    .filter((row) => row.name.startsWith(`${userId}/`))
    .map((row) => ({ path: fromKey(userId, row.name), etag: normalizeEtag(row.etag) }));
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

export async function writeFile(
  userId: string,
  path: string,
  text: string,
  contentType = "text/markdown"
): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).upload(toKey(userId, path), text, {
    upsert: true,
    // Never let a CDN or browser cache hand another device a stale copy.
    cacheControl: "0",
    contentType: `${contentType}; charset=utf-8`,
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
