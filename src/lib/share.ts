import type { PublishedDocument } from "../types";

// The published document is packed into the URL fragment itself, so a link
// works cross-device with no server: whoever opens it decodes the payload
// locally. The tradeoff is link length grows with the piece — a backend
// store (see PROJECT_PLAN.md §7) is the natural upgrade for short links.
const HASH_PREFIX = "doc=";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeDocument(doc: PublishedDocument): string {
  const json = JSON.stringify(doc);
  const bytes = new TextEncoder().encode(json);
  return toBase64Url(bytes);
}

export function decodeDocument(payload: string): PublishedDocument | null {
  try {
    const bytes = fromBase64Url(payload);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    if (typeof parsed?.content !== "string") return null;
    return parsed as PublishedDocument;
  } catch {
    return null;
  }
}

export function buildShareUrl(doc: PublishedDocument): string {
  const encoded = encodeDocument(doc);
  return `${window.location.origin}${window.location.pathname}#${HASH_PREFIX}${encoded}`;
}

export function readShareHash(): PublishedDocument | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodeDocument(hash.slice(HASH_PREFIX.length));
}
