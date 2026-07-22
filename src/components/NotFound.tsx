import { useEffect } from "react";
import { resolveInitialTheme } from "../lib/storage";
import { Wordmark } from "./Wordmark";

export function NotFound() {
  useEffect(() => {
    document.documentElement.dataset.theme = resolveInitialTheme();
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--rule)] px-6 py-4">
        <Wordmark />
      </header>
      <main className="mx-auto max-w-[720px] px-6 pt-16">
        <p className="font-write-serif text-[1.2rem] italic text-[var(--fg-muted)]">
          This page doesn&rsquo;t exist, or was never published.
        </p>
        <a
          href={window.location.pathname}
          className="mt-6 inline-block font-write-mono text-[11px] uppercase tracking-wide text-[var(--accent)] underline underline-offset-4"
        >
          Write your own
        </a>
      </main>
    </div>
  );
}
