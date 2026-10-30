import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { livePreview } from "../lib/editor/livePreview";
import { provenance, provenanceField, readProvenance } from "../lib/editor/provenance";
import type { PasteRange } from "../lib/provenance";
import type { Note } from "../lib/vaultSync";
import { resolveLink } from "../lib/wikilinks";
import { FONT_CLASS } from "../fonts";
import type { FontName, WritingStats } from "../types";

const markdownStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, class: "cm-mono" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.url, t.labelName], color: "var(--fg-muted)" },
  { tag: t.quote, color: "var(--fg-muted)" },
]);

// The writing surface for one note: a live-preview Markdown editor that
// owns the note's hand-writing record while open. Mount it with a `key` per
// note (and per server version) so switching notes starts from that note's
// own record.
export function NoteEditor({
  note,
  font,
  showPasted,
  paths,
  onFollowLink,
  onChange,
}: {
  note: Note;
  font: FontName;
  showPasted: boolean;
  paths: string[];
  onFollowLink: (target: string) => void;
  onChange: (body: string, stats: WritingStats, pasteRanges: PasteRange[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The editor is built once; these always point at the latest props.
  const latest = useRef({ paths, onFollowLink, onChange });
  latest.current = { paths, onFollowLink, onChange };

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: note.body,
        extensions: [
          provenance(note.body, note.stats, note.pasteRanges),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // The language and its list/quote keys only: markdown() would also
          // load HTML, CSS and JavaScript support, doubling the app's size.
          markdownLanguage,
          Prec.high(keymap.of(markdownKeymap)),
          syntaxHighlighting(markdownStyle),
          livePreview({
            exists: (target) => resolveLink(target, latest.current.paths) !== null,
            follow: (target) => latest.current.onFollowLink(target),
          }),
          EditorView.lineWrapping,
          placeholder("Start writing. Link other notes with [[double brackets]]."),
          EditorView.contentAttributes.of({ spellcheck: "true", autocapitalize: "sentences", "aria-label": "Note" }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const { stats, pasteRanges } = readProvenance(update.state.field(provenanceField));
            latest.current.onChange(update.state.doc.toString(), stats, pasteRanges);
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
    // Only on mount: afterwards the editor is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className={`${FONT_CLASS[font]} note-editor${showPasted ? "" : " hide-pasted"}`} />;
}
