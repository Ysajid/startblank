// Every note has a canonical address in the vault: its path in the URL
// fragment (#note=Ideas/On%20walking.md), next to the #doc= links of
// published pages. Like the rest of the vault it only opens for its owner.
const HASH_PREFIX = "note=";

export function noteHash(path: string): string {
  return `#${HASH_PREFIX}${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function noteUrl(path: string): string {
  return `${window.location.origin}${window.location.pathname}${noteHash(path)}`;
}

export function readNoteHash(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(HASH_PREFIX)) return null;
  try {
    const path = hash.slice(HASH_PREFIX.length).split("/").map(decodeURIComponent).join("/");
    return path || null;
  } catch {
    return null; // a mangled link
  }
}
