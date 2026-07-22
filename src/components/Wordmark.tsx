import { useEffect, useState } from "react";
import { fetchPublishedCount } from "../lib/documentsApi";

export function Wordmark() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPublishedCount().then((n) => {
      if (!cancelled) setCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex items-baseline gap-3">
      <span className="font-write-serif text-[15px] italic text-[var(--fg)]">startblank</span>
      <span className="hidden font-write-serif text-[12px] text-[var(--fg-muted)] sm:inline">
        — it takes a human to think.
      </span>
      {count !== null ? (
        <span className="hidden font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)] md:inline">
          · {count.toLocaleString()} published
        </span>
      ) : null}
    </div>
  );
}
