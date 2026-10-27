import { supabase } from "./supabase";

// Notes are files, not rows: each account's vault is a folder on the vault
// server (server/ in this repo, e.g. on a DigitalOcean droplet), stored
// under the notes' real names. Every request carries the user's Supabase
// access token; the server only ever touches that user's folder.
//
// Paths are vault-relative ("Ideas/On walking.md").

const API = (import.meta.env.VITE_VAULT_API_URL ?? "").replace(/\/$/, "");

// Marks a folder that has no notes in it yet (so empty folders survive).
export const FOLDER_MARKER = ".keep";

export interface RemoteFile {
  path: string;
  etag: string;
}

// The server refused a conditional write: the file changed since the etag
// we sent (or exists when we expected it not to).
export class FileChangedError extends Error {}

export class VaultRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function request(method: string, route: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new VaultRequestError(401, "signed out");
  const res = await fetch(`${API}${route}`, {
    method,
    body: init.body,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (res.status === 412) throw new FileChangedError(route);
  return res;
}

async function failure(res: Response): Promise<VaultRequestError> {
  const detail = await res.json().catch(() => null);
  return new VaultRequestError(res.status, detail?.error ?? `vault server answered ${res.status}`);
}

function fileRoute(path: string) {
  return `/v1/file?path=${encodeURIComponent(path)}`;
}

function etagHeader(res: Response): string | null {
  return res.headers.get("ETag")?.replace(/^W\//, "").replace(/"/g, "") ?? null;
}

export async function listVault(): Promise<RemoteFile[]> {
  const res = await request("GET", "/v1/files");
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function readFile(path: string): Promise<string> {
  const res = await request("GET", fileRoute(path));
  if (!res.ok) throw await failure(res);
  return res.text();
}

// The file's etag on the server right now, or null if it doesn't exist.
export async function remoteEtag(path: string): Promise<string | null> {
  const res = await request("HEAD", fileRoute(path));
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  return etagHeader(res);
}

// Writes the file and returns its new etag. With `expected`, the write only
// happens if the file is still at that etag (null: still doesn't exist) —
// otherwise FileChangedError, and nothing is overwritten.
export async function writeFile(path: string, text: string, expected?: string | null): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
  if (expected === null) headers["If-None-Match"] = "*";
  else if (expected !== undefined) headers["If-Match"] = `"${expected}"`;
  const res = await request("PUT", fileRoute(path), { body: text, headers });
  if (!res.ok) throw await failure(res);
  return (await res.json()).etag;
}

export async function moveFile(from: string, to: string): Promise<void> {
  const res = await request("POST", "/v1/move", {
    body: JSON.stringify({ from, to }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw await failure(res);
}

export async function removeFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const res = await request("POST", "/v1/delete", {
    body: JSON.stringify({ paths }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw await failure(res);
}

// Rebuilds this user's search index from their files on the server.
export async function reindexVault(): Promise<number> {
  const res = await request("POST", "/v1/reindex");
  if (!res.ok) throw await failure(res);
  return (await res.json()).indexed;
}
