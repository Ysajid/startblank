// The URL fragment carries only the document's slug — the actual content
// lives in Supabase (see supabase/schema.sql) and is looked up by slug via
// get_document_by_slug(), a keyed lookup with no way to enumerate documents.
const HASH_PREFIX = "doc=";

export function buildShareUrl(slug: string): string {
  return `${window.location.origin}${window.location.pathname}#${HASH_PREFIX}${slug}`;
}

export function readShareSlug(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const slug = hash.slice(HASH_PREFIX.length);
  return slug || null;
}

export function linkedInShareUrl(pageUrl: string): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
}
