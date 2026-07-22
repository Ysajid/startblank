import { useEffect, useRef, useState } from "react";
import { useWritingStats } from "../lib/useWritingStats";
import { computeBlankScore } from "../lib/blankScore";
import { loadDraft, loadPrefs, resolveInitialTheme, savePrefs, saveDraft } from "../lib/storage";
import type { FontName, ThemeName } from "../types";
import { ThemeSwitch } from "./ThemeSwitch";
import { FontSwitch } from "./FontSwitch";
import { PublishPanel } from "./PublishPanel";
import { Wordmark } from "./Wordmark";

const FONT_CLASS: Record<FontName, string> = {
  serif: "font-write-serif",
  sans: "font-write-sans",
  mono: "font-write-mono",
};

export function Writer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const { statsRef, runs, handleInput, reset, getPasteRanges } = useWritingStats();
  const saveTimer = useRef<number | undefined>(undefined);

  const [theme, setTheme] = useState<ThemeName>("light");
  const [font, setFont] = useState<FontName>("serif");
  const [content, setContent] = useState("");
  const [liveScore, setLiveScore] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    setTheme(resolveInitialTheme());
    setFont(loadPrefs().font);

    const draft = loadDraft();
    if (draft && textareaRef.current) {
      textareaRef.current.value = draft.content;
      setContent(draft.content);
      reset(draft.content, draft.stats, draft.pasteRanges);
      setLiveScore(computeBlankScore(draft.stats, draft.content.length).score);
    }
  }, [reset]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    savePrefs({ theme, font });
  }, [theme, font]);

  function queueSave() {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveDraft({
        content: textareaRef.current?.value ?? "",
        stats: statsRef.current,
        pasteRanges: getPasteRanges(),
      });
    }, 600);
  }

  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    handleInput(event);
    const value = event.currentTarget.value;
    setContent(value);
    setLiveScore(computeBlankScore(statsRef.current, value.length).score);
    queueSave();
  }

  function onScroll(event: React.UIEvent<HTMLTextAreaElement>) {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = event.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  function clearDraftAndStart() {
    if (content.length > 0 && !window.confirm("Clear this page? This cannot be undone.")) return;
    if (textareaRef.current) textareaRef.current.value = "";
    reset();
    setContent("");
    setLiveScore(0);
    saveDraft({ content: "", stats: statsRef.current, pasteRanges: [] });
    textareaRef.current?.focus();
  }

  const charCount = content.length;
  const wordCount = charCount === 0 ? 0 : content.trim().split(/\s+/).length;

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--rule)] px-6 py-4">
        <Wordmark />
        <div className="flex items-center gap-6">
          <FontSwitch value={font} onChange={setFont} />
          <div className="h-4 w-px bg-[var(--rule)]" />
          <ThemeSwitch value={theme} onChange={setTheme} />
          <div className="h-4 w-px bg-[var(--rule)]" />
          <button
            type="button"
            onClick={clearDraftAndStart}
            className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setPublishOpen(true)}
            className="rounded-sm border border-[var(--fg)] px-3 py-1.5 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Publish
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[720px] px-6 pb-24 pt-16">
        <div className="relative">
          <div
            ref={backdropRef}
            aria-hidden="true"
            className={`${FONT_CLASS[font]} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-0 text-[1.2rem] leading-relaxed text-transparent`}
            style={{ minHeight: "70vh" }}
          >
            {runs.map((run, i) =>
              run.isPasted ? (
                <span key={i} style={{ backgroundColor: "var(--paste-mark)" }}>
                  {content.slice(run.start, run.start + run.length)}
                </span>
              ) : (
                <span key={i}>{content.slice(run.start, run.start + run.length)}</span>
              )
            )}
          </div>
          <textarea
            ref={textareaRef}
            onInput={onInput}
            onScroll={onScroll}
            autoFocus
            placeholder="Start writing."
            spellCheck
            className={`${FONT_CLASS[font]} relative block w-full resize-none border-none bg-transparent p-0 text-[1.2rem] leading-relaxed text-[var(--fg)] placeholder:italic placeholder:text-[var(--fg-muted)]`}
            style={{ minHeight: "70vh" }}
          />
        </div>
      </main>

      <footer className="fixed inset-x-6 bottom-6 flex items-end justify-between">
        <div>
          <div className="font-write-mono text-2xl leading-none tabular-nums text-[var(--fg)]">
            {charCount}
          </div>
          <div className="mt-1 font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
            characters · {wordCount} {wordCount === 1 ? "word" : "words"}
          </div>
        </div>
        <div className="text-right">
          <div className="font-write-mono text-2xl leading-none tabular-nums text-[var(--fg)]">
            {charCount === 0 ? "—" : liveScore.toFixed(1)}
          </div>
          <div className="mt-1 font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
            blank score
          </div>
        </div>
      </footer>

      <PublishPanel
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        getSnapshot={() => ({
          content: textareaRef.current?.value ?? "",
          stats: { ...statsRef.current },
        })}
        theme={theme}
        font={font}
      />
    </div>
  );
}
