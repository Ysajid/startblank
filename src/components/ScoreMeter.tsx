import { useState } from "react";

export function ScoreMeter({ score, label }: { score: number; label?: string }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const rounded = Math.round(score * 10) / 10;
  const display = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-write-mono text-4xl tabular-nums text-[var(--fg)]">{display}</span>
        <span className="font-write-mono text-xs text-[var(--fg-muted)]">/ 100</span>
      </div>
      <div className="mt-3 h-[2px] w-full bg-[var(--rule)]">
        <div
          className="h-full bg-[var(--accent)]"
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
      {label ? (
        <div className="mt-2 flex items-center gap-1.5">
          <p className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
            {label}
          </p>
          <button
            type="button"
            onClick={() => setInfoOpen((open) => !open)}
            aria-expanded={infoOpen}
            aria-label="How the Blank Score is calculated"
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[var(--fg-muted)] font-write-mono text-[9px] leading-none text-[var(--fg-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            i
          </button>
        </div>
      ) : null}
      {infoOpen ? (
        <div className="mt-3 rounded-sm border border-[var(--rule)] p-4 text-[12px] leading-relaxed text-[var(--fg-muted)]">
          <p>Rewards writing and revising by hand; discounts pasted text.</p>
          <dl className="mt-3 flex flex-col gap-2 font-write-mono text-[11px]">
            <div>
              <dt className="inline text-[var(--fg)]">Organic</dt>
              <dd className="inline"> — share of characters typed rather than pasted</dd>
            </div>
            <div>
              <dt className="inline text-[var(--fg)]">Kept</dt>
              <dd className="inline"> — share of the final text that isn&rsquo;t pasted in</dd>
            </div>
            <div>
              <dt className="inline text-[var(--fg)]">Revision</dt>
              <dd className="inline"> — typing alone scores 90; edits can add up to 10 more</dd>
            </div>
          </dl>
          <p className="mt-3 font-write-mono text-[11px] text-[var(--fg)]">
            Score = 100 × Organic × Kept × Revision
          </p>
        </div>
      ) : null}
    </div>
  );
}
