// startblank note indexer (Supabase Edge Function, Deno).
//
// Reads note files from the `vaults` bucket and keeps public.note_index
// (see supabase/search.sql) in step: searchable words, title, [[link]]
// targets and a short excerpt. It never stores the note text itself.
//
// Callers:
//   - the app, as the signed-in user, after it saves / moves / deletes a
//     note: { op: "upsert" | "delete", paths: [...] } or { op: "reindex" }
//   - the optional storage.objects trigger, with the shared secret:
//     { op: "upsert" | "delete", keys: [...] }  (raw storage keys)
//
// Deploy with `supabase functions deploy index-note --no-verify-jwt` — it
// checks the caller itself, since the trigger has no user JWT.

import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "vaults";
const MAX_INDEXED_CHARS = 500_000;
const EXCERPT_CHARS = 240;

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const indexerSecret = Deno.env.get("NOTE_INDEXER_SECRET");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---- Keys <-> vault paths (mirror of src/lib/vaultStorage.ts) ---------------

const SAFE_CHAR = /[A-Za-z0-9 _\-.()!,'&@;+$]/;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function encodeSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (SAFE_CHAR.test(ch)) out += ch;
    else for (const byte of utf8.encode(ch)) out += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
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

function toKey(owner: string, path: string): string {
  return `${owner}/${path.split("/").map(encodeSegment).join("/")}`;
}

function fromKey(key: string): { owner: string; path: string } {
  const [owner, ...rest] = key.split("/");
  return { owner, path: rest.map(decodeSegment).join("/") };
}

function isNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md") && !path.split("/").some((s) => s.startsWith("."));
}

// ---- Reading a note (mirror of src/lib/noteFile.ts / wikilinks.ts) ----------

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const close = body.indexOf("\n---", 3);
  if (close === -1 || (close + 4 < body.length && body[close + 4] !== "\n")) return body;
  return body.slice(close + 5);
}

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;

function linkTargets(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets = new Set<string>();
  for (const m of withoutCode.matchAll(WIKILINK)) targets.add(m[1].trim().replace(/\.md$/i, "").toLowerCase());
  return [...targets];
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (_m, target, label) => label ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

async function indexOne(owner: string, path: string): Promise<void> {
  if (!isNote(path)) return;
  const { data, error } = await admin.storage.from(BUCKET).download(toKey(owner, path));
  if (error) {
    // Gone by the time we got here (moved or deleted right after saving).
    await unindexOne(owner, path);
    return;
  }
  const body = stripFrontmatter((await data.text()).replace(/\r\n/g, "\n"));
  const text = plainText(body);
  const { error: rpcError } = await admin.rpc("index_note", {
    p_owner: owner,
    p_path: path,
    p_title: titleOf(path),
    p_text: text.slice(0, MAX_INDEXED_CHARS),
    p_excerpt: text.slice(0, EXCERPT_CHARS),
    p_links: linkTargets(body),
  });
  if (rpcError) throw rpcError;
}

async function unindexOne(owner: string, path: string): Promise<void> {
  if (!isNote(path)) return;
  const { error } = await admin.rpc("unindex_note", { p_owner: owner, p_path: path });
  if (error) throw error;
}

async function listNotes(owner: string): Promise<string[]> {
  const paths: string[] = [];
  const queue = [owner];
  while (queue.length > 0) {
    const prefix = queue.shift()!;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
      if (error) throw error;
      for (const entry of data) {
        const key = `${prefix}/${entry.name}`;
        if (entry.id === null) queue.push(key);
        else paths.push(fromKey(key).path);
      }
      if (data.length < 1000) break;
    }
  }
  return paths.filter(isNote);
}

// Rebuilds one user's index from their files, dropping rows for notes that
// no longer exist.
async function reindex(owner: string): Promise<number> {
  const paths = await listNotes(owner);
  for (let i = 0; i < paths.length; i += 8) {
    await Promise.all(paths.slice(i, i + 8).map((p) => indexOne(owner, p)));
  }
  const { data: rows, error } = await admin.from("note_index").select("path").eq("owner_id", owner);
  if (error) throw error;
  const live = new Set(paths);
  for (const row of rows ?? []) if (!live.has(row.path)) await unindexOne(owner, row.path);
  return paths.length;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Either the storage trigger (shared secret, any owner) or a signed-in
  // user (their own vault only).
  let user: string | null = null;
  const fromTrigger = !!indexerSecret && req.headers.get("x-indexer-secret") === indexerSecret;
  if (!fromTrigger) {
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer /, "");
    const { data, error } = jwt ? await admin.auth.getUser(jwt) : { data: null, error: true };
    if (error || !data?.user) return json({ error: "unauthorized" }, 401);
    user = data.user.id;
  }

  let payload: { op?: string; paths?: unknown; keys?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  try {
    if (payload.op === "reindex") {
      if (!user) return json({ error: "reindex needs a user" }, 400);
      return json({ indexed: await reindex(user) });
    }
    if (payload.op !== "upsert" && payload.op !== "delete") return json({ error: "unknown op" }, 400);

    const targets: { owner: string; path: string }[] = [];
    if (fromTrigger && Array.isArray(payload.keys)) {
      for (const key of payload.keys) if (typeof key === "string") targets.push(fromKey(key));
    } else if (user && Array.isArray(payload.paths)) {
      for (const path of payload.paths) if (typeof path === "string") targets.push({ owner: user, path });
    }

    const run = payload.op === "upsert" ? indexOne : unindexOne;
    await Promise.all(targets.map((t) => run(t.owner, t.path)));
    return json({ done: targets.length });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
