import { config } from "./config.js";
import { etag, listFiles, readFile } from "./files.js";

// Keeps public.note_index in Supabase (see supabase/search.sql) in step with
// the files: searchable words, title, [[link]] targets and a short excerpt.
// The note text itself is never sent to the database.

const MAX_INDEXED_CHARS = 500_000;
const EXCERPT_CHARS = 240;

export function isNote(vaultPath: string): boolean {
  return vaultPath.toLowerCase().endsWith(".md") && !vaultPath.split("/").some((s) => s.startsWith("."));
}

// ---- Reading a note (mirrors src/lib/noteFile.ts and wikilinks.ts) ----------

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const close = body.indexOf("\n---", 3);
  if (close === -1 || (close + 4 < body.length && body[close + 4] !== "\n")) return body;
  return body.slice(close + 5);
}

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;

function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function linkTargets(body: string): string[] {
  const targets = new Set<string>();
  for (const m of stripCode(body).matchAll(WIKILINK)) targets.add(m[1].trim().replace(/\.md$/i, "").toLowerCase());
  return [...targets];
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(WIKILINK, (_m, target: string, label?: string) => label ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(vaultPath: string): string {
  return vaultPath.slice(vaultPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

// ---- Talking to Supabase -----------------------------------------------------

// Works with both kinds of Supabase key: a secret key (sb_secret_…) goes
// in `apikey` only — Supabase rejects it as a bearer token — while a legacy
// service_role key is a JWT and is also sent as the bearer token.
function supabaseHeaders(): Record<string, string> {
  const key = config.serviceRoleKey;
  return key.startsWith("eyJ") ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...supabaseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// What each note was last indexed at, so the same version isn't indexed
// twice (once by the API that wrote it, once by the folder watcher).
const indexedAt = new Map<string, string>();

export async function indexNote(userId: string, vaultPath: string): Promise<void> {
  if (!isNote(vaultPath)) return;
  const key = `${userId}/${vaultPath}`;
  let file;
  try {
    file = await readFile(userId, vaultPath);
  } catch {
    await unindexNote(userId, vaultPath);
    return;
  }
  if (indexedAt.get(key) === file.etag) return;
  const body = stripFrontmatter(file.text.replace(/\r\n/g, "\n"));
  const text = plainText(body);
  await rpc("index_note", {
    p_owner: userId,
    p_path: vaultPath,
    p_title: titleOf(vaultPath),
    p_text: text.slice(0, MAX_INDEXED_CHARS),
    p_excerpt: text.slice(0, EXCERPT_CHARS),
    p_links: linkTargets(body),
  });
  indexedAt.set(key, file.etag);
}

export async function unindexNote(userId: string, vaultPath: string): Promise<void> {
  if (!isNote(vaultPath)) return;
  indexedAt.delete(`${userId}/${vaultPath}`);
  await rpc("unindex_note", { p_owner: userId, p_path: vaultPath });
}

// Index or unindex, whichever matches what's on disk now.
export async function syncNote(userId: string, vaultPath: string): Promise<void> {
  if (!isNote(vaultPath)) return;
  if ((await etag(userId, vaultPath).catch(() => null)) === null) await unindexNote(userId, vaultPath);
  else await indexNote(userId, vaultPath);
}

// Rebuilds one account's index from its folder, dropping rows for notes
// that no longer exist.
export async function reindexUser(userId: string): Promise<number> {
  const notes = (await listFiles(userId)).map((f) => f.path).filter(isNote);
  for (const p of notes) indexedAt.delete(`${userId}/${p}`);
  for (let i = 0; i < notes.length; i += 8) {
    await Promise.all(notes.slice(i, i + 8).map((p) => indexNote(userId, p)));
  }
  const res = await fetch(
    `${config.supabaseUrl}/rest/v1/note_index?select=path&owner_id=eq.${encodeURIComponent(userId)}`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`listing the index failed: ${res.status}`);
  const live = new Set(notes);
  for (const row of (await res.json()) as { path: string }[]) {
    if (!live.has(row.path)) await unindexNote(userId, row.path);
  }
  return notes.length;
}

// Best-effort from request handlers: a slow or failed index update only
// delays search results, so it never fails the save that caused it.
export function indexInBackground(task: Promise<unknown>): void {
  task.catch((e) => console.error("[index]", e instanceof Error ? e.message : e));
}
