import { useEffect, useMemo, useRef, useState } from "react";
import { noteTitle, parentOf } from "../lib/vaultSync";

const MAX_RESULTS = 12;

// Ctrl/Cmd+O: jump to a note by name, or create it if nothing matches.
export function QuickSwitcher({
  paths,
  onOpen,
  onCreate,
  onClose,
}: {
  paths: string[];
  onOpen: (path: string) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...paths].sort((a, b) => noteTitle(a).localeCompare(noteTitle(b))).slice(0, MAX_RESULTS);
    // Titles that start with the query first, then any path containing it.
    const starts = paths.filter((p) => noteTitle(p).toLowerCase().startsWith(q));
    const contains = paths.filter((p) => !starts.includes(p) && p.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, MAX_RESULTS);
  }, [paths, query]);

  const canCreate =
    query.trim() !== "" && !paths.some((p) => noteTitle(p).toLowerCase() === query.trim().toLowerCase());
  const rowCount = results.length + (canCreate ? 1 : 0);

  function choose(index: number) {
    if (index < results.length) onOpen(results[index]);
    else if (canCreate) onCreate(query.trim());
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(rowCount - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape") {
      onClose();
    }
  }

  const rowClass = (i: number) =>
    `flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left ${
      i === active ? "bg-[var(--rule)]" : ""
    }`;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/30 px-4 pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-[520px] border border-[var(--rule)] bg-[var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Open note"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Find or create a note…"
          className="w-full border-b border-[var(--rule)] bg-transparent px-4 py-3 font-write-mono text-[14px] text-[var(--fg)] focus:outline-none"
        />
        <ul className="max-h-[50vh] overflow-auto py-1">
          {results.map((path, i) => (
            <li key={path}>
              <button
                type="button"
                className={rowClass(i)}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="truncate text-[14px] text-[var(--fg)]">{noteTitle(path)}</span>
                <span className="shrink-0 truncate font-write-mono text-[11px] text-[var(--fg-muted)]">
                  {parentOf(path)}
                </span>
              </button>
            </li>
          ))}
          {canCreate ? (
            <li>
              <button
                type="button"
                className={rowClass(results.length)}
                onMouseEnter={() => setActive(results.length)}
                onClick={() => choose(results.length)}
              >
                <span className="truncate text-[14px] text-[var(--accent)]">Create “{query.trim()}”</span>
              </button>
            </li>
          ) : null}
          {rowCount === 0 ? (
            <li className="px-4 py-3 text-[13px] text-[var(--fg-muted)]">No notes yet.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
