import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { AuthError, userIdFromRequest } from "./auth.js";
import {
  ConflictError,
  NotFoundError,
  PathError,
  PreconditionError,
  etag,
  listFiles,
  moveFile,
  readFile,
  removeFiles,
  writeFile,
} from "./files.js";
import { indexInBackground, indexNote, reindexUser, syncNote, unindexNote } from "./indexer.js";
import { watchVaults } from "./watcher.js";

// The startblank vault API. Every route acts on the signed-in user's own
// folder only; paths are vault-relative ("Ideas/On walking.md").
//
//   GET    /v1/files                 every file in the vault, with etags
//   GET    /v1/file?path=…           a file's text (ETag header)
//   HEAD   /v1/file?path=…           just its ETag, 404 if missing
//   PUT    /v1/file?path=…           write it; If-Match: <etag> or
//                                    If-None-Match: * make it conditional
//   POST   /v1/move    {from, to}
//   POST   /v1/delete  {paths}
//   POST   /v1/reindex               rebuild this user's search index
//   GET    /healthz

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
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body?: unknown, headers = {}) {
  const isText = typeof body === "string";
  res.writeHead(status, {
    ...corsHeaders(req),
    "Cache-Control": "no-store",
    ...(body === undefined ? {} : { "Content-Type": isText ? "text/markdown; charset=utf-8" : "application/json" }),
    ...headers,
  });
  res.end(body === undefined || req.method === "HEAD" ? undefined : isText ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "file too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readBody(req, 1024 * 1024));
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  throw new HttpError(400, "expected a JSON object");
}

// "If-Match: <etag>" -> that etag; "If-None-Match: *" -> must not exist.
function expectedEtag(req: IncomingMessage): string | null | undefined {
  const ifMatch = req.headers["if-match"];
  if (typeof ifMatch === "string" && ifMatch) return ifMatch.replace(/^W\//, "").replace(/"/g, "");
  if (req.headers["if-none-match"] === "*") return null;
  return undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://vault");
  if (req.method === "OPTIONS") return send(req, res, 204);
  if (url.pathname === "/healthz") return send(req, res, 200, { ok: true });

  const userId = await userIdFromRequest(req.headers.authorization);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /v1/files":
      return send(req, res, 200, await listFiles(userId));

    case "GET /v1/file":
    case "HEAD /v1/file": {
      const vaultPath = url.searchParams.get("path") ?? "";
      if (req.method === "HEAD") {
        const tag = await etag(userId, vaultPath);
        return tag === null ? send(req, res, 404) : send(req, res, 200, undefined, { ETag: `"${tag}"` });
      }
      const file = await readFile(userId, vaultPath);
      return send(req, res, 200, file.text, { ETag: `"${file.etag}"` });
    }

    case "PUT /v1/file": {
      const vaultPath = url.searchParams.get("path") ?? "";
      const text = await readBody(req, config.maxFileBytes);
      const tag = await writeFile(userId, vaultPath, text, expectedEtag(req));
      indexInBackground(indexNote(userId, vaultPath));
      return send(req, res, 200, { etag: tag }, { ETag: `"${tag}"` });
    }

    case "POST /v1/move": {
      const { from, to } = await readJson(req);
      if (typeof from !== "string" || typeof to !== "string") throw new HttpError(400, "from and to required");
      await moveFile(userId, from, to);
      indexInBackground(unindexNote(userId, from).then(() => indexNote(userId, to)));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/delete": {
      const { paths } = await readJson(req);
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
        throw new HttpError(400, "paths must be a list of strings");
      }
      await removeFiles(userId, paths as string[]);
      for (const p of paths as string[]) indexInBackground(syncNote(userId, p));
      return send(req, res, 200, { ok: true });
    }

    case "POST /v1/reindex":
      return send(req, res, 200, { indexed: await reindexUser(userId) });

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
    if (e instanceof PreconditionError) return send(req, res, 412, { error: "file changed" });
    console.error(e);
    send(req, res, 500, { error: "internal error" });
  });
});

async function main() {
  await fs.mkdir(path.resolve(config.vaultRoot), { recursive: true });

  // `node dist/index.js reindex-all`: rebuild every account's search index
  // from the files (e.g. after restoring a backup), then exit.
  if (process.argv[2] === "reindex-all") {
    const users = (await fs.readdir(path.resolve(config.vaultRoot), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.name))
      .map((d) => d.name);
    for (const user of users) console.log(`${user}: ${await reindexUser(user)} notes`);
    return;
  }

  if (config.watch) watchVaults();
  server.listen(config.port, config.host, () => {
    console.log(`[vault] listening on http://${config.host}:${config.port}, files under ${config.vaultRoot}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
