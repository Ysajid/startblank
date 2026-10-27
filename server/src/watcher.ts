import { watch } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { indexInBackground, isNote, reindexUser, syncNote } from "./indexer.js";

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETTLE_MS = 500;

// Indexes notes that change on disk without going through the API — an
// agent editing files in a vault folder, a script, an rsync. Changes are
// settled for a moment so a burst of writes indexes once.
export function watchVaults(): void {
  const root = path.resolve(config.vaultRoot);
  const pending = new Map<string, NodeJS.Timeout>();

  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const [userId, ...rest] = filename.toString().split(path.sep);
    const vaultPath = rest.join("/");
    if (!UUID_DIR.test(userId) || vaultPath === "" || vaultPath.split("/").some((s) => s.startsWith("."))) return;
    // A folder renamed or deleted wholesale (`mv Ideas Thoughts`) reports
    // only the folder, not each note in it, so re-check that whole vault.
    const isFolderEvent = !isNote(vaultPath) && !/\.[^/]*$/.test(vaultPath);
    if (!isNote(vaultPath) && !isFolderEvent) return;
    const key = isFolderEvent ? userId : `${userId}/${vaultPath}`;
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        indexInBackground(isFolderEvent ? reindexUser(userId) : syncNote(userId, vaultPath));
      }, isFolderEvent ? SETTLE_MS * 4 : SETTLE_MS)
    );
  });
  watcher.on("error", (e) => console.error("[watch]", e.message));
  console.log(`[watch] indexing changes under ${root}`);
}
