import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { AuthError, userIdFromRequest } from "./auth.js";
import { asUser, pool } from "./db.js";
import {
  ConflictError,
  NotFoundError,
  PathError,
  VersionError,
  backlinks,
  checkPath,
  createFolder,
  deleteFolder,
  deleteNotes,
  history,
  listVault,
  moveFolder,
  moveNote,
  readNote,
  saveNote,
  searchNotes,
} from "./vault.js";

// The startblank vault API. Every route acts on the signed-in user's vault
// only; paths are vault-relative ("Ideas/On walking.md").
//
//   GET  /v1/vault                       {notes: [{path, version}], folders}
//   GET  /v1/note?path=…                 {body, record, version, updatedBy}
//   PUT  /v1/note?path=…                 {body, record, baseVersion} -> {version}
//                                        (412 if baseVersion isn't current)
//   POST /v1/notes/move    {from, to}
//   POST /v1/notes/delete  {paths}
//   POST /v1/folders       {path}
//   POST /v1/folders/move  {from, to}
//   POST /v1/folders/delete {path}
//   GET  /v1/search?q=…                  [{path, title, excerpt}]
//   GET  /v1/backlinks?path=…            [path]
//   GET  /v1/history?path=…              revisions, newest first
//   GET  /healthz

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, {
    ...corsHeaders(req),
    "Cache-Control": "no-store",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const limit = config.maxNoteBytes * 2 + 64 * 1024; // body + its record
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "note too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "expected a JSON object");
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new HttpError(400, `${name} must be a list of strings`);
  }
  return value;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://vault");
  if (req.method === "OPTIONS") return send(req, res, 204);
  if (url.pathname === "/healthz") {
    await pool.query("select 1");
    return send(req, res, 200, { ok: true });
  }

  const userId = await userIdFromRequest(req.headers.authorization);
  const q = (name: string) => url.searchParams.get(name);

  switch (`${req.method} ${url.pathname}`) {
    case "GET /v1/vault":
      return send(req, res, 200, await asUser(userId, (tx) => listVault(tx, userId)));

    case "GET /v1/note": {
      const path = checkPath(q("path"), "note");
      return send(req, res, 200, await asUser(userId, (tx) => readNote(tx, userId, path)));
    }

    case "PUT /v1/note": {
      const path = checkPath(q("path"), "note");
      const { body, record, baseVersion } = await readJson(req);
      if (typeof body !== "string") throw new HttpError(400, "body must be a string");
      if (Buffer.byteLength(body) > config.maxNoteBytes) throw new HttpError(413, "note too large");
      if (record !== null && typeof record !== "string") throw new HttpError(400, "record must be a string or null");
      if (baseVersion !== null && !Number.isSafeInteger(baseVersion)) {
        throw new HttpError(400, "baseVersion must be a version number, or null to create");
      }
      const version = await asUser(userId, (tx) =>
        saveNote(tx, userId, path, body, record, baseVersion as number | null, "app")
      );
      return send(req, res, 200, { version });
    }

    case "POST /v1/notes/move": {
      const { from, to } = await readJson(req);
      const [a, b] = [checkPath(from, "note"), checkPath(to, "note")];
      await asUser(userId, (tx) => moveNote(tx, userId, a, b));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/notes/delete": {
      const paths = stringList((await readJson(req)).paths, "paths").map((p) => checkPath(p, "note"));
      await asUser(userId, (tx) => deleteNotes(tx, userId, paths));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/folders": {
      const path = checkPath((await readJson(req)).path, "folder");
      await asUser(userId, (tx) => createFolder(tx, userId, path));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/folders/move": {
      const { from, to } = await readJson(req);
      const [a, b] = [checkPath(from, "folder"), checkPath(to, "folder")];
      await asUser(userId, (tx) => moveFolder(tx, userId, a, b));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/folders/delete": {
      const path = checkPath((await readJson(req)).path, "folder");
      await asUser(userId, (tx) => deleteFolder(tx, userId, path));
      return send(req, res, 200, { ok: true });
    }

    case "GET /v1/search":
      return send(req, res, 200, await asUser(userId, (tx) => searchNotes(tx, userId, q("q") ?? "")));

    case "GET /v1/backlinks": {
      const path = checkPath(q("path"), "note");
      return send(req, res, 200, await asUser(userId, (tx) => backlinks(tx, userId, path)));
    }

    case "GET /v1/history": {
      const path = checkPath(q("path"), "note");
      return send(req, res, 200, await asUser(userId, (tx) => history(tx, userId, path)));
    }

    default:
      throw new HttpError(404, "not found");
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(req, res, e.status, { error: e.message });
    if (e instanceof AuthError) return send(req, res, 401, { error: e.message });
    if (e instanceof PathError) return send(req, res, 400, { error: e.message });
    if (e instanceof NotFoundError) return send(req, res, 404, { error: "not found" });
    if (e instanceof ConflictError) return send(req, res, 409, { error: "already exists" });
    if (e instanceof VersionError) return send(req, res, 412, { error: "note changed" });
    // Log the failure, never the request: note paths and text are private.
    console.error(`${req.method} ${new URL(req.url ?? "/", "http://vault").pathname}:`, e instanceof Error ? e.message : e);
    send(req, res, 500, { error: "internal error" });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[vault] listening on http://${config.host}:${config.port}`);
});
