import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// Live preview: the note stays plain Markdown text, but it's drawn as it
// will read. Markup (#, **, `, [[ ]], link targets, list dashes) is hidden
// except where the cursor or selection is, so it can still be edited. No
// text is ever rewritten — what's saved is exactly what was typed.

export interface LinkHandlers {
  exists: (target: string) => boolean;
  follow: (target: string) => void;
}

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;
const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode"]);

const hidden = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const rawWikilink = Decoration.mark({ class: "cm-wikilink-raw" });

function line(cls: string) {
  return Decoration.line({ class: cls });
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task";
    box.setAttribute("aria-label", this.checked ? "Done" : "To do");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

// Ticks or unticks the `[ ]` on the line at `pos`.
function toggleTask(view: EditorView, pos: number) {
  const { from, text } = view.state.doc.lineAt(pos);
  const match = /\[( |x|X)\]/.exec(text);
  if (!match) return;
  const at = from + match.index + 1;
  view.dispatch({ changes: { from: at, to: at + 1, insert: match[1] === " " ? "x" : " " }, userEvent: "input.toggle" });
}

// A YAML frontmatter block is metadata, not Markdown: shown plainly.
function frontmatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text !== "---") return 0;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text === "---") return doc.line(n).to;
  }
  return 0;
}

function build(view: EditorView, links: LinkHandlers): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // Markup shows only around the cursor, and only while editing.
  const ranges = view.hasFocus ? state.selection.ranges : [];
  const touched = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number) => {
    const l = doc.lineAt(pos);
    return touched(l.from, l.to);
  };

  const decos: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (to > from) decos.push(hidden.range(from, to));
  };
  const lineClass = (pos: number, cls: string) => decos.push(line(cls).range(doc.lineAt(pos).from));
  const linesClass = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos);
      lineClass(l.from, cls);
      pos = l.to + 1;
    }
  };
  // A mark plus the single space that follows it ("# ", "> ").
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);

  const front = frontmatterEnd(state);
  if (front) linesClass(0, front, "cm-frontmatter");
  const code: { from: number; to: number }[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        if (ref.from < front) return false;
        const node = ref.node;
        const name = ref.name;

        if (CODE.has(name)) code.push({ from: ref.from, to: ref.to });

        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          lineClass(ref.from, `cm-h${heading[2]}`);
          if (!touched(ref.from, ref.to)) {
            const marks = node.getChildren("HeaderMark");
            marks.forEach((mark, i) => {
              if (heading[1] === "Setext") hide(mark.from, mark.to);
              else if (i === 0) hide(mark.from, withSpace(mark.to));
              else hide(doc.sliceString(mark.from - 1, mark.from) === " " ? mark.from - 1 : mark.from, mark.to);
            });
          }
          return;
        }

        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
          case "InlineCode": {
            if (name === "InlineCode") decos.push(inlineCode.range(ref.from, ref.to));
            if (!touched(ref.from, ref.to)) {
              for (const mark of children(node, ["EmphasisMark", "StrikethroughMark", "CodeMark"])) {
                hide(mark.from, mark.to);
              }
            }
            return;
          }
          case "Link": {
            const marks = node.getChildren("LinkMark");
            const url = node.getChild("URL");
            if (marks.length < 2 || !url || touched(ref.from, ref.to)) return;
            hide(ref.from, marks[0].to);
            hide(marks[1].from, ref.to);
            decos.push(
              Decoration.mark({
                class: "cm-link",
                attributes: { "data-href": doc.sliceString(url.from, url.to) },
              }).range(marks[0].to, marks[1].from)
            );
            return false;
          }
          case "URL": {
            const parent = node.parent?.name;
            if (parent === "Link" || parent === "Image" || touched(ref.from, ref.to)) return;
            decos.push(
              Decoration.mark({ class: "cm-link", attributes: { "data-href": doc.sliceString(ref.from, ref.to) } }).range(
                ref.from,
                ref.to
              )
            );
            return;
          }
          case "QuoteMark": {
            lineClass(ref.from, "cm-quote");
            if (!lineTouched(ref.from)) hide(ref.from, withSpace(ref.to));
            return;
          }
          case "ListMark": {
            const item = node.parent;
            if (item?.getChild("Task") || item?.parent?.name !== "BulletList" || lineTouched(ref.from)) return;
            decos.push(Decoration.replace({ widget: new BulletWidget() }).range(ref.from, ref.to));
            return;
          }
          case "Task": {
            const marker = node.getChild("TaskMarker");
            const listMark = node.parent?.getChild("ListMark");
            if (!marker) return;
            const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
            if (checked) lineClass(ref.from, "cm-task-done");
            if (!lineTouched(ref.from)) {
              decos.push(
                Decoration.replace({ widget: new CheckboxWidget(checked) }).range(
                  listMark?.from ?? marker.from,
                  withSpace(marker.to)
                )
              );
            }
            return;
          }
          case "HorizontalRule": {
            if (lineTouched(ref.from)) return;
            lineClass(ref.from, "cm-hr");
            hide(ref.from, ref.to);
            return;
          }
          case "FencedCode":
          case "CodeBlock": {
            linesClass(ref.from, ref.to, "cm-codeblock");
            return false;
          }
        }
      },
    });

    // [[Wikilinks]] aren't standard Markdown, so they're found by pattern —
    // anywhere but in code.
    const text = doc.sliceString(from, to);
    for (const match of text.matchAll(WIKILINK)) {
      const start = from + match.index!;
      const end = start + match[0].length;
      if (start < front || code.some((c) => c.from <= start && c.to >= end)) continue;
      if (touched(start, end)) {
        decos.push(rawWikilink.range(start, end));
        continue;
      }
      const target = match[1].trim();
      const labelFrom = match[2] ? end - 2 - match[2].length : start + 2;
      hide(start, labelFrom);
      hide(end - 2, end);
      decos.push(
        Decoration.mark({
          class: links.exists(target) ? "cm-link" : "cm-link cm-link-missing",
          attributes: { "data-target": target },
        }).range(labelFrom, end - 2)
      );
    }
  }

  return Decoration.set(decos, true);
}

function children(node: SyntaxNode, names: string[]): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) found.push(child);
  }
  return found;
}

export function livePreview(links: LinkHandlers) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, links);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = build(update.view, links);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );

  // A link that's drawn as a link opens on click, like a page; move the
  // cursor into it with the keyboard to edit it.
  const clicks = EditorView.domEventHandlers({
    mousedown(event) {
      if (event.button !== 0) return false;
      const link = (event.target as HTMLElement).closest<HTMLElement>("[data-target], [data-href]");
      if (!link) return false;
      event.preventDefault();
      if (link.dataset.target) links.follow(link.dataset.target);
      else if (link.dataset.href) window.open(link.dataset.href, "_blank", "noopener,noreferrer");
      return true;
    },
  });

  return [plugin, clicks];
}
