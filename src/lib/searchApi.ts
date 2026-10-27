import { supabase } from "./supabase";
import { noteTitle } from "./vaultSync";

// Search and backlinks run on the server against public.note_index (see
// supabase/search.sql), which the vault server builds from the note files
// as they change — so the app never has to download a note it isn't
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

// Rebuilds this user's search index from their files (the vault server
// also keeps it current by itself as files change).
export { reindexVault as rebuildIndex } from "./vaultStorage";
