import { supabase } from "./supabase";

// Notes live in Postgres behind the vault server (server/ in this repo, on
// a DigitalOcean droplet). Each note is one row: its Markdown text and its
// hand-writing record, saved together. Every request carries the user's
// Supabase access token, and the database itself only ever shows a user
// their own rows.
//
// Paths are vault-relative ("Ideas/On walking.md"); folders are prefixes.

const API = (import.meta.env.VITE_VAULT_API_URL ?? "").replace(/\/$/, "");

export interface VaultListing {
  notes: { path: string; version: number }[];
  // Folders that exist on their own (possibly empty).
  folders: string[];
}

export interface StoredNote {
  body: string;
  record: string | null;
  version: number;
}

export interface SearchHit {
  path: string;
  title: string;
  excerpt: string;
}

// A save named a version that's no longer current: something else (another
// device, an agent) changed the note first. Nothing was overwritten.
export class NoteChangedError extends Error {}

export class NotFoundError extends Error {}

export class VaultRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(method: string, route: string, json?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new VaultRequestError(401, "signed out");
  const res = await fetch(`${API}${route}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  if (res.status === 412) throw new NoteChangedError(route);
  if (res.status === 404) throw new NotFoundError(route);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new VaultRequestError(res.status, detail?.error ?? `vault server answered ${res.status}`);
  }
  return res.json();
}

const q = (path: string) => encodeURIComponent(path);

export function listVault(): Promise<VaultListing> {
  return request("GET", "/v1/vault");
}

export function readNote(path: string): Promise<StoredNote> {
  return request("GET", `/v1/note?path=${q(path)}`);
}

// Saves text and record together, only if the note is still at
// `baseVersion` (null: only if it doesn't exist yet). Returns the new
// version, or throws NoteChangedError.
export async function saveNote(
  path: string,
  body: string,
  record: string | null,
  baseVersion: number | null
): Promise<number> {
  return (await request<{ version: number }>("PUT", `/v1/note?path=${q(path)}`, { body, record, baseVersion }))
    .version;
}

export async function moveNote(from: string, to: string): Promise<void> {
  await request("POST", "/v1/notes/move", { from, to });
}

export async function deleteNotes(paths: string[]): Promise<void> {
  if (paths.length > 0) await request("POST", "/v1/notes/delete", { paths });
}

export async function createFolder(path: string): Promise<void> {
  await request("POST", "/v1/folders", { path });
}

// Moves a folder with everything in it, in one step on the server.
export async function moveFolder(from: string, to: string): Promise<void> {
  await request("POST", "/v1/folders/move", { from, to });
}

export async function deleteFolder(path: string): Promise<void> {
  await request("POST", "/v1/folders/delete", { path });
}

export function searchNotes(query: string): Promise<SearchHit[]> {
  return request("GET", `/v1/search?q=${q(query)}`);
}

export function fetchBacklinks(path: string): Promise<string[]> {
  return request("GET", `/v1/backlinks?path=${q(path)}`);
}
