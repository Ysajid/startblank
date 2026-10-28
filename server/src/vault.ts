import type { Tx } from "./db.js";

// Every function here runs inside asUser(), so row-level security already
// limits it to the signed-in user's rows; the explicit owner filters are a
// second lock on the same door.

export class PathError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
// A save named a version that is no longer current (or expected the note
// not to exist and it does): someone else changed it first.
export class VersionError extends Error {}

const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_BYTES = 255;

// Paths look like file paths ("Ideas/On walking.md") so they export cleanly
// as a folder of Markdown files, and are held to the same rules.
export function checkPath(value: unknown, kind: "note" | "folder"): string {
  if (typeof value !== "string" || value === "") throw new PathError(`${kind} path required`);
  if (value.length > MAX_PATH_CHARS) throw new PathError("path too long");
  if (/[\0\\]/.test(value) || /[\u0000-\u001f]/.test(value)) throw new PathError("invalid character in path");
  for (const segment of value.split("/")) {
    if (segment === "" || segment.startsWith(".")) throw new PathError("invalid path segment");
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) throw new PathError("name too long");
  }
  if (kind === "note" && !value.toLowerCase().endsWith(".md")) throw new PathError("notes end in .md");
  return value;
}

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

// Lower-cased [[link]] targets, ignoring links inside code (mirrors
// src/lib/wikilinks.ts).
const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;

export function linkTargets(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const targets = new Set<string>();
  for (const m of withoutCode.matchAll(WIKILINK)) targets.add(m[1].trim().replace(/\.md$/i, "").toLowerCase());
  return [...targets];
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "23505";
}

// ---- Reading -----------------------------------------------------------------

export async function listVault(tx: Tx, userId: string) {
  const notes = await tx.query<{ path: string; version: string }>(
    "select path, version from notes where owner_id = $1 order by path",
    [userId]
  );
  const folders = await tx.query<{ path: string }>("select path from folders where owner_id = $1 order by path", [
    userId,
  ]);
  return {
    notes: notes.rows.map((r) => ({ path: r.path, version: Number(r.version) })),
    folders: folders.rows.map((r) => r.path),
  };
}

export async function readNote(tx: Tx, userId: string, path: string) {
  const { rows } = await tx.query<{ body: string; record: string | null; version: string; updated_by: string }>(
    "select body, record, version, updated_by from notes where owner_id = $1 and path = $2",
    [userId, path]
  );
  if (rows.length === 0) throw new NotFoundError(path);
  return { body: rows[0].body, record: rows[0].record, version: Number(rows[0].version), updatedBy: rows[0].updated_by };
}

// ---- Writing -----------------------------------------------------------------

// Saves a note's text and hand-writing record together. `baseVersion` is the
// version the writer started from (null: they're creating it); if that is no
// longer current, nothing is written and VersionError is thrown.
export async function saveNote(
  tx: Tx,
  userId: string,
  path: string,
  body: string,
  record: string | null,
  baseVersion: number | null,
  author: string
): Promise<number> {
  const links = linkTargets(body);
  let row: { id: string; version: string } | undefined;
  if (baseVersion === null) {
    ({
      rows: [row],
    } = await tx.query(
      `insert into notes (owner_id, path, title, body, record, links, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (owner_id, path) do nothing
       returning id, version`,
      [userId, path, titleOf(path), body, record, links, author]
    ));
  } else {
    ({
      rows: [row],
    } = await tx.query(
      `update notes
          set body = $3, record = $4, links = $5, updated_by = $6,
              version = version + 1, updated_at = now()
        where owner_id = $1 and path = $2 and version = $7
        returning id, version`,
      [userId, path, body, record, links, author, baseVersion]
    ));
  }
  if (!row) throw new VersionError(path);
  await recordRevision(tx, userId, row.id, Number(row.version), body, author);
  return Number(row.version);
}

// Autosave writes every second or so while someone types; fold those into
// the author's latest revision instead of keeping hundreds of near-copies.
const FOLD_WINDOW = "10 minutes";

async function recordRevision(tx: Tx, userId: string, noteId: string, version: number, body: string, author: string) {
  const folded = await tx.query(
    `update note_revisions set body = $3, version = $4, updated_at = now()
      where id = (select id from note_revisions where note_id = $1 order by id desc limit 1)
        and author = $2 and created_at > now() - interval '${FOLD_WINDOW}'`,
    [noteId, author, body, version]
  );
  if (folded.rowCount === 0) {
    await tx.query(
      "insert into note_revisions (note_id, owner_id, version, body, author) values ($1, $2, $3, $4, $5)",
      [noteId, userId, version, body, author]
    );
  }
}

export async function moveNote(tx: Tx, userId: string, from: string, to: string) {
  try {
    const { rowCount } = await tx.query(
      "update notes set path = $3, title = $4 where owner_id = $1 and path = $2",
      [userId, from, to, titleOf(to)]
    );
    if (rowCount === 0) throw new NotFoundError(from);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError(to);
    throw e;
  }
}

export async function deleteNotes(tx: Tx, userId: string, paths: string[]) {
  await tx.query("delete from notes where owner_id = $1 and path = any($2)", [userId, paths]);
}

// ---- Folders -----------------------------------------------------------------

// "a/b" is under "a" when it starts with "a/" — compared with left() rather
// than LIKE, so names containing % or _ aren't treated as wildcards.
const UNDER = "left(path, length($2) + 1) = $2 || '/'";

export async function createFolder(tx: Tx, userId: string, path: string) {
  await tx.query("insert into folders (owner_id, path) values ($1, $2) on conflict do nothing", [userId, path]);
}

export async function moveFolder(tx: Tx, userId: string, from: string, to: string) {
  const clash = await tx.query(
    `select 1 from notes where owner_id = $1 and (path = $2 or left(path, length($2) + 1) = $2 || '/')
     union all
     select 1 from folders where owner_id = $1 and (path = $2 or left(path, length($2) + 1) = $2 || '/')
     limit 1`,
    [userId, to]
  );
  if (clash.rowCount) throw new ConflictError(to);
  const notes = await tx.query(
    `update notes set path = $3 || substr(path, length($2) + 1)
      where owner_id = $1 and ${UNDER}`,
    [userId, from, to]
  );
  const folders = await tx.query(
    `update folders set path = $3 || substr(path, length($2) + 1)
      where owner_id = $1 and (path = $2 or ${UNDER})`,
    [userId, from, to]
  );
  if (notes.rowCount === 0 && folders.rowCount === 0) throw new NotFoundError(from);
}

export async function deleteFolder(tx: Tx, userId: string, path: string) {
  await tx.query(`delete from notes where owner_id = $1 and ${UNDER}`, [userId, path]);
  await tx.query(`delete from folders where owner_id = $1 and (path = $2 or ${UNDER})`, [userId, path]);
}

// ---- Search, links, history ----------------------------------------------------

// Every word must match, the last one as a prefix (search as you type);
// titles also match as plain substrings.
export async function searchNotes(tx: Tx, userId: string, query: string, limit = 40) {
  const words = query
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (words.length === 0) return [];
  const tsquery = words.map((w) => `'${w.replace(/'/g, "''")}':*`).join(" & ");
  const needle = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await tx.query<{ path: string; title: string; excerpt: string }>(
    `with q as (select to_tsquery('simple', $2) as q)
     select n.path, n.title,
            ts_headline('simple', left(n.body, 20000), q.q,
                        'StartSel="", StopSel="", MaxWords=24, MinWords=8, MaxFragments=1') as excerpt
       from notes n, q
      where n.owner_id = $1 and (n.search @@ q.q or n.title ilike $3)
      order by (ts_rank(n.search, q.q) + case when n.title ilike $3 then 1 else 0 end) desc, n.title
      limit $4`,
    [userId, tsquery, needle, Math.min(Math.max(limit, 1), 200)]
  );
  return rows;
}

// Notes linking to `path`, by any of the ways it can be linked to:
// [[Folder/Note]] or [[Note]].
export async function backlinks(tx: Tx, userId: string, path: string) {
  const keys = [...new Set([path.replace(/\.md$/i, "").toLowerCase(), titleOf(path).toLowerCase()])];
  const { rows } = await tx.query<{ path: string }>(
    "select path from notes where owner_id = $1 and links && $2 and path <> $3 order by title",
    [userId, keys, path]
  );
  return rows.map((r) => r.path);
}

export async function history(tx: Tx, userId: string, path: string) {
  const { rows } = await tx.query<{ version: string; author: string; created_at: Date; updated_at: Date; length: number }>(
    `select r.version, r.author, r.created_at, r.updated_at, length(r.body) as length
       from note_revisions r join notes n on n.id = r.note_id
      where n.owner_id = $1 and n.path = $2
      order by r.id desc
      limit 200`,
    [userId, path]
  );
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}
