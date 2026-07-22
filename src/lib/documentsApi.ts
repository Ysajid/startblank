import { supabase } from "./supabase";
import { generateSlug } from "./slug";
import type { FontName, PublishedDocument, ThemeName, WritingStats } from "../types";

interface DocumentRow {
  slug: string;
  content: string;
  theme: string;
  font: string;
  stats: WritingStats;
  final_length: number;
  score: number;
  published_at: string;
}

function fromRow(row: DocumentRow): PublishedDocument {
  return {
    content: row.content,
    theme: row.theme as ThemeName,
    font: row.font as FontName,
    stats: row.stats,
    finalLength: row.final_length,
    score: row.score,
    publishedAt: new Date(row.published_at).getTime(),
  };
}

const MAX_SLUG_ATTEMPTS = 5;
const UNIQUE_VIOLATION = "23505";

export type DraftDocument = Omit<PublishedDocument, "publishedAt">;

// Retries with a fresh slug only on an actual collision (astronomically
// unlikely at 10 random chars) — any other error is surfaced immediately.
export async function publishDocument(doc: DraftDocument): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    const { error } = await supabase.from("documents").insert({
      slug,
      content: doc.content,
      theme: doc.theme,
      font: doc.font,
      stats: doc.stats,
      final_length: doc.finalLength,
      score: doc.score,
    });
    if (!error) return slug;
    lastError = error;
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) break;
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to publish document");
}

export async function fetchDocumentBySlug(slug: string): Promise<PublishedDocument | null> {
  const { data, error } = await supabase.rpc("get_document_by_slug", { p_slug: slug });
  if (error || !data || data.length === 0) return null;
  return fromRow(data[0] as DocumentRow);
}

export async function fetchPublishedCount(): Promise<number | null> {
  const { data, error } = await supabase.rpc("get_published_count");
  if (error || data == null) return null;
  // Postgres bigint can come back as either a JSON number or a numeric string.
  const count = typeof data === "string" ? parseInt(data, 10) : data;
  return typeof count === "number" && !Number.isNaN(count) ? count : null;
}
