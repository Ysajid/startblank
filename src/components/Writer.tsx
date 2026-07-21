import { useEffect, useRef, useState } from "react";
import { useWritingStats } from "../lib/useWritingStats";
import { loadDraft, loadPrefs, savePrefs, saveDraft } from "../lib/storage";
import type { FontName, ThemeName } from "../types";
import { ThemeSwitch } from "./ThemeSwitch";
import { FontSwitch } from "./FontSwitch";
import { PublishPanel } from "./PublishPanel";

const FONT_CLASS: Record<FontName, string> = {
  serif: "font-write-serif",
  sans: "font-write-sans",
  mono: "font-write-mono",
};

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function Writer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { statsRef, handleInput, reset } = useWritingStats();
  const saveTimer = useRef<number | undefined>(undefined);

  const [theme, setTheme] = useState<ThemeName>("light");
  const [font, setFont] = useState<FontName>("serif");
  const [charCount, setCharCount] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    const prefs = loadPrefs();
    const hasSavedTheme = localStorage.getItem("startblank.prefs") !== null;
    setTheme(hasSavedTheme ? prefs.theme : prefersDark() ? "dark" : "light");
    setFont(prefs.font);

    const draft = loadDraft();
    if (draft && textareaRef.current) {
      textareaRef.current.value = draft.content;
      setCharCount(draft.content.length);
      reset(draft.stats);
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
      saveDraft({ content: textareaRef.current?.value ?? "", stats: statsRef.current });
    }, 600);
  }

  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    handleInput(event);
    setCharCount(event.currentTarget.value.length);
    queueSave();
  }

  function clearDraftAndStart() {
    if (charCount > 0 && !window.confirm("Clear this page? This cannot be undone.")) return;
    if (textareaRef.current) textareaRef.current.value = "";
    reset();
    setCharCount(0);
    saveDraft({ content: "", stats: statsRef.current });
    textareaRef.current?.focus();
  }

  const wordCount = charCount === 0 ? 0 : (textareaRef.current?.value.trim().split(/\s+/).length ?? 0);

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--rule)] px-6 py-4">
        <span className="font-write-serif text-[15px] italic text-[var(--fg)]">startblank</span>
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
        <textarea
          ref={textareaRef}
          onInput={onInput}
          autoFocus
          placeholder="Start writing."
          spellCheck
          className={`${FONT_CLASS[font]} block w-full resize-none border-none bg-transparent text-[1.2rem] leading-relaxed text-[var(--fg)] placeholder:italic placeholder:text-[var(--fg-muted)]`}
          style={{ minHeight: "70vh" }}
        />
      </main>

      <footer className="fixed bottom-6 left-6 font-write-mono text-[11px] text-[var(--fg-muted)]">
        {wordCount} {wordCount === 1 ? "word" : "words"} · {charCount} characters
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
