import { supabase } from "./supabase";
import { noteTitle } from "./vaultSync";

// Search and backlinks run on the server against public.note_index (see
// supabase/search.sql), which the `index-note` Edge Function builds from
// the note files — so the app never has to download a note it isn't
// showing.

export interface SearchHit {
  path: string;
  title: string;
  excerpt: string;
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  const { data, error } = await supabase.rpc("search_notes", { p_query: query });
  if (error) throw error;
  return (data ?? []).map((row: SearchHit) => ({ path: row.path, title: row.title, excerpt: row.excerpt }));
}

// The ways a note can be linked to: [[Folder/Note]] or just [[Note]].
export function linkKeys(path: string): string[] {
  return [...new Set([path.replace(/\.md$/i, "").toLowerCase(), noteTitle(path).toLowerCase()])];
}

export async function fetchBacklinks(path: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("note_backlinks", { p_targets: linkKeys(path) });
  if (error) throw error;
  return (data ?? []).map((row: { path: string }) => row.path).filter((p: string) => p !== path);
}

// Fire-and-forget: the index catching up late only delays search results,
// so a failure here never fails the save that triggered it.
export function requestIndex(op: "upsert" | "delete", paths: string[]): void {
  if (paths.length === 0) return;
  supabase.functions.invoke("index-note", { body: { op, paths } }).catch(() => undefined);
}

export async function rebuildIndex(): Promise<number> {
  const { data, error } = await supabase.functions.invoke("index-note", { body: { op: "reindex" } });
  if (error) throw error;
  return (data as { indexed: number }).indexed;
}
