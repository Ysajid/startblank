import { unzipSync } from "fflate";
import { NOTE_EXT } from "./vaultSync";

// Reads a .zip of Markdown files (an exported vault, a folder of notes) into
// vault paths. Folder structure is kept; anything that isn't a .md file is
// skipped, as are hidden files and the junk macOS adds to archives.

export interface ZipImport {
  notes: { path: string; body: string }[];
  // Folders in the archive that hold no notes (they'd vanish otherwise).
  emptyFolders: string[];
  skipped: number;
}

// Zip entry names are untrusted: normalise separators, drop "." / ".."
// segments and anything hidden, and refuse names that end up empty.
function cleanPath(name: string): string | null {
  const segments = name.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === ".." || s.startsWith(".") || s === "__MACOSX")) return null;
  return segments.join("/");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

export function readMarkdownZip(data: Uint8Array): ZipImport {
  const entries = unzipSync(data);
  const notes: ZipImport["notes"] = [];
  const dirs = new Set<string>();
  let skipped = 0;

  for (const [name, bytes] of Object.entries(entries)) {
    const path = cleanPath(name);
    if (name.endsWith("/")) {
      if (path) dirs.add(path);
      continue;
    }
    if (!path || !path.toLowerCase().endsWith(NOTE_EXT)) {
      skipped++;
      continue;
    }
    // Keep the extension's case consistent with notes made in the app.
    notes.push({ path: `${path.slice(0, -NOTE_EXT.length)}${NOTE_EXT}`, body: decode(bytes) });
  }

  // A zip of one folder ("Vault/…") imports that folder's contents rather
  // than nesting everything one level deeper.
  const roots = new Set([...notes.map((n) => n.path), ...dirs].map((p) => p.split("/")[0]));
  if (roots.size === 1 && notes.every((n) => n.path.includes("/"))) {
    const root = `${[...roots][0]}/`;
    for (const n of notes) n.path = n.path.slice(root.length);
    for (const d of [...dirs]) {
      dirs.delete(d);
      if (d.startsWith(root)) dirs.add(d.slice(root.length));
    }
  }

  const emptyFolders = [...dirs].filter((d) => !notes.some((n) => n.path.startsWith(`${d}/`))).sort();
  notes.sort((a, b) => a.path.localeCompare(b.path));
  return { notes, emptyFolders, skipped };
}
