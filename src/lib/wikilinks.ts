import { Marked, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import { stripFrontmatter } from "./noteFile";
import { noteTitle } from "./vaultSync";

// Obsidian-style links: [[Note]], [[Folder/Note]], [[Note|shown text]],
// [[Note#Heading]]. A link resolves to the note whose path matches, else
// to the first note with that title anywhere in the vault.

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;

export function linkTargets(body: string): string[] {
  const targets: string[] = [];
  for (const match of stripCode(body).matchAll(WIKILINK)) targets.push(match[1].trim());
  return targets;
}

// Links inside code are examples, not links.
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function resolveLink(target: string, paths: string[]): string | null {
  const wanted = target.replace(/\.md$/i, "").toLowerCase();
  const byPath = paths.find((p) => p.replace(/\.md$/i, "").toLowerCase() === wanted);
  if (byPath) return byPath;
  return paths.find((p) => noteTitle(p).toLowerCase() === wanted) ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(body: string, paths: string[]): string {
  const wikilink: TokenizerAndRendererExtension = {
    name: "wikilink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenizer(src) {
      const match = /^\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!match) return undefined;
      return { type: "wikilink", raw: match[0], target: match[1].trim(), label: (match[2] ?? match[1]).trim() };
    },
    renderer(token) {
      const resolved = resolveLink(token.target, paths) !== null;
      return `<a href="#" class="wikilink${resolved ? "" : " wikilink-missing"}" data-target="${escapeHtml(
        token.target
      )}">${escapeHtml(token.label)}</a>`;
    },
  };

  const marked = new Marked({ gfm: true, breaks: true, extensions: [wikilink] });
  const html = marked.parse(stripFrontmatter(body), { async: false });
  // Notes are user-written Markdown, which may contain raw HTML — never
  // render it unsanitized.
  return DOMPurify.sanitize(html);
}
