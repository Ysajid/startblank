import { supabase } from "./supabase";

// Notes live in Supabase Postgres (see supabase/vault.sql). Each note is one
// row: its Markdown text and its hand-writing record, saved together.
// Row-level security keeps every user to their own rows, and note text is
// written only through save_note(), which refuses a save that starts from
// an outdated version and records the revision.
//
// Paths are vault-relative ("Ideas/On walking.md"); folders are prefixes.

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

export class AlreadyExistsError extends Error {}

interface PgError {
  code?: string;
  message: string;
}

function fail(error: PgError): never {
  if (error.code === "P0002") throw new NotFoundError(error.message);
  if (error.code === "23505") throw new AlreadyExistsError("Something with that name already exists.");
  throw new Error(error.message);
}

export async function listVault(): Promise<VaultListing> {
  const { data, error } = await supabase.rpc("list_vault");
  if (error) fail(error);
  const listing = data as { notes: { path: string; version: number | string }[]; folders: string[] };
  return {
    notes: listing.notes.map((n) => ({ path: n.path, version: Number(n.version) })),
    folders: listing.folders,
  };
}

export async function readNote(path: string): Promise<StoredNote> {
  const { data, error } = await supabase
    .from("notes")
    .select("body, record, version")
    .eq("path", path)
    .maybeSingle();
  if (error) fail(error);
  if (!data) throw new NotFoundError(path);
  return { body: data.body, record: data.record, version: Number(data.version) };
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
  const { data, error } = await supabase.rpc("save_note", {
    p_path: path,
    p_body: body,
    p_record: record,
    p_base_version: baseVersion,
  });
  if (error) fail(error);
  if (data === null) throw new NoteChangedError(path);
  return Number(data);
}

export async function moveNote(from: string, to: string): Promise<void> {
  const { error } = await supabase.rpc("move_note", { p_from: from, p_to: to });
  if (error) fail(error);
}

export async function deleteNotes(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.from("notes").delete().in("path", paths);
  if (error) fail(error);
}

export async function createFolder(path: string): Promise<void> {
  const { error } = await supabase.from("folders").upsert({ path }, { onConflict: "owner_id,path", ignoreDuplicates: true });
  if (error) fail(error);
}

// Moves a folder with everything in it, in one step on the server.
export async function moveFolder(from: string, to: string): Promise<void> {
  const { error } = await supabase.rpc("move_folder", { p_from: from, p_to: to });
  if (error) fail(error);
}

export async function deleteFolder(path: string): Promise<void> {
  const { error } = await supabase.rpc("delete_folder", { p_path: path });
  if (error) fail(error);
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  const { data, error } = await supabase.rpc("search_notes", { p_query: query });
  if (error) fail(error);
  return (data ?? []) as SearchHit[];
}

export async function fetchBacklinks(path: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("note_backlinks", { p_path: path });
  if (error) fail(error);
  return (data ?? []) as string[];
}
