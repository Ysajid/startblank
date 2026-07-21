export function Wordmark() {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-write-serif text-[15px] italic text-[var(--fg)]">startblank</span>
      <span className="hidden font-write-serif text-[12px] text-[var(--fg-muted)] sm:inline">
        — it takes a human to think.
      </span>
    </div>
  );
}
