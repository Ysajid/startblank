import { useEffect } from "react";
import { clearDraft } from "../lib/storage";
import type { FontName, PublishedDocument } from "../types";
import { ScoreMeter } from "./ScoreMeter";

const FONT_CLASS: Record<FontName, string> = {
  serif: "font-write-serif",
  sans: "font-write-sans",
  mono: "font-write-mono",
};

export function ReadOnly({ doc }: { doc: PublishedDocument }) {
  useEffect(() => {
    document.documentElement.dataset.theme = doc.theme;
  }, [doc.theme]);

  const wordCount = doc.content.trim() === "" ? 0 : doc.content.trim().split(/\s+/).length;
  const publishedDate = new Date(doc.publishedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--rule)] px-6 py-4">
        <span className="font-write-serif text-[15px] italic text-[var(--fg)]">startblank</span>
        <a
          href={window.location.pathname}
          onClick={() => clearDraft()}
          className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Write your own
        </a>
      </header>

      <div className="mx-auto flex max-w-[720px] flex-col gap-6 border-b border-[var(--rule)] px-6 pb-8 pt-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="w-full max-w-[200px] sm:order-2">
          <ScoreMeter score={doc.score} label="Blank score" />
        </div>
        <div className="sm:order-1">
          <p className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
            Published {publishedDate}
          </p>
          <p className="mt-1 font-write-mono text-[11px] text-[var(--fg-muted)]">
            {wordCount} {wordCount === 1 ? "word" : "words"} · {doc.finalLength} characters
          </p>
        </div>
      </div>

      <main className="mx-auto max-w-[720px] px-6 pb-24 pt-10">
        <p
          className={`${FONT_CLASS[doc.font]} whitespace-pre-wrap text-[1.2rem] leading-relaxed text-[var(--fg)]`}
        >
          {doc.content}
        </p>
      </main>
    </div>
  );
}
