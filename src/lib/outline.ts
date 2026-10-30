// A note's headings, for its table of contents: in order, with where each
// starts in the text. Headings inside code blocks or frontmatter don't
// count, so the list matches the headings the reading view renders.

export interface Heading {
  level: number;
  text: string;
  // Offset of the heading's line in the note text.
  from: number;
}

// The heading as it reads: no emphasis, code ticks or link syntax.
function plain(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .trim();
}

export function outline(body: string): Heading[] {
  const lines = body.split("\n");
  const headings: Heading[] = [];
  let offset = 0;
  let fence: string | null = null;
  let start = 0;

  // Skip a frontmatter block.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) {
      for (let i = 0; i <= close; i++) offset += lines[i].length + 1;
      start = close + 1;
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const from = offset;
    offset += line.length + 1;

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const text = plain(atx[2]);
      if (text) headings.push({ level: atx[1].length, text, from });
      continue;
    }

    // Setext: a line of text underlined with === (h1) or --- (h2).
    const next = lines[i + 1];
    if (next !== undefined && line.trim() !== "" && !/^ {0,3}([-*+>]|\d+[.)])\s/.test(line)) {
      const level = /^ {0,3}=+[ \t]*$/.test(next) ? 1 : /^ {0,3}-+[ \t]*$/.test(next) ? 2 : 0;
      const prev = i > start ? lines[i - 1] : "";
      if (level && prev.trim() === "") {
        const text = plain(line);
        if (text) headings.push({ level, text, from });
      }
    }
  }
  return headings;
}
