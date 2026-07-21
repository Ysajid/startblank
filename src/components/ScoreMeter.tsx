export function ScoreMeter({ score, label }: { score: number; label?: string }) {
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
        <p className="mt-2 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
          {label}
        </p>
      ) : null}
    </div>
  );
}
