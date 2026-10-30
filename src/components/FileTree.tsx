import { useEffect, useRef, useState } from "react";
import { baseName, noteTitle, parentOf } from "../lib/vaultSync";

interface FolderNode {
  path: string;
  folders: FolderNode[];
  notes: string[];
}

function buildTree(folders: string[], notes: string[]): FolderNode {
  const root: FolderNode = { path: "", folders: [], notes: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  const nodeFor = (path: string): FolderNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const node: FolderNode = { path, folders: [], notes: [] };
    byPath.set(path, node);
    nodeFor(parentOf(path)).folders.push(node);
    return node;
  };
  for (const folder of folders) nodeFor(folder);
  for (const note of notes) nodeFor(parentOf(note)).notes.push(note);
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    node.notes.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export interface TreeActions {
  onOpen: (path: string) => void;
  onNewNote: (folder: string) => void;
  onRename: (path: string, kind: "note" | "folder") => void;
  onDelete: (path: string, kind: "note" | "folder") => void;
}

const rowAction =
  "font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--accent)]";

export function FileTree({
  folders,
  notes,
  dirty,
  selected,
  reveal,
  actions,
}: {
  folders: string[];
  notes: string[];
  dirty: Set<string>;
  selected: string | null;
  // A note to show: its folders are opened, it's scrolled to and flashed.
  // A new object each time, so the same note can be located again.
  reveal: { path: string } | null;
  actions: TreeActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flashing, setFlashing] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const tree = buildTree(folders, notes);
  const listed = reveal !== null && notes.includes(reveal.path);

  useEffect(() => {
    if (!reveal || !listed) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (let p = parentOf(reveal.path); p; p = parentOf(p)) next.delete(p);
      return next;
    });
    setFlashing(reveal.path);
    // Scroll once the opened folders have rendered.
    const frame = requestAnimationFrame(() => {
      const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-note]") ?? [])].find(
        (el) => el.dataset.note === reveal.path
      );
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setFlashing(null), 1500);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reveal, listed]);

  const allFolders: string[] = [];
  const collect = (node: FolderNode) => {
    for (const folder of node.folders) {
      allFolders.push(folder.path);
      collect(folder);
    }
  };
  collect(tree);
  const allCollapsed = allFolders.length > 0 && allFolders.every((f) => collapsed.has(f));
  const noneCollapsed = allFolders.every((f) => !collapsed.has(f));

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderFolder(node: FolderNode, depth: number): React.ReactNode {
    return (
      <>
        {node.folders.map((folder) => {
          const isCollapsed = collapsed.has(folder.path);
          return (
            <li key={folder.path}>
              <div
                className="group flex items-center justify-between gap-2 py-1 pr-2"
                style={{ paddingLeft: depth * 14 + 8 }}
              >
                <button
                  type="button"
                  onClick={() => toggle(folder.path)}
                  className="flex min-w-0 items-center gap-1.5 text-left text-[13px] text-[var(--fg)]"
                  aria-expanded={!isCollapsed}
                >
                  <span className="w-3 shrink-0 font-write-mono text-[10px] text-[var(--fg-muted)]">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="truncate">{baseName(folder.path)}</span>
                </button>
                <span className="hidden shrink-0 gap-2 group-focus-within:flex group-hover:flex">
                  <button type="button" className={rowAction} onClick={() => actions.onNewNote(folder.path)}>
                    + Note
                  </button>
                  <button type="button" className={rowAction} onClick={() => actions.onRename(folder.path, "folder")}>
                    Rename
                  </button>
                  <button type="button" className={rowAction} onClick={() => actions.onDelete(folder.path, "folder")}>
                    Delete
                  </button>
                </span>
              </div>
              {isCollapsed ? null : <ul>{renderFolder(folder, depth + 1)}</ul>}
            </li>
          );
        })}
        {node.notes.map((note) => {
          const isSelected = note === selected;
          return (
            <li key={note}>
              <div
                data-note={note}
                className={`group flex items-center justify-between gap-2 py-1 pr-2 outline-1 -outline-offset-1 outline-[var(--accent)] ${
                  isSelected ? "bg-[var(--rule)]" : ""
                } ${note === flashing ? "outline" : ""}`}
                style={{ paddingLeft: depth * 14 + 8 + 18 }}
              >
                <button
                  type="button"
                  onClick={() => actions.onOpen(note)}
                  className={`min-w-0 truncate text-left text-[13px] ${
                    isSelected ? "text-[var(--accent)]" : "text-[var(--fg)]"
                  }`}
                >
                  {noteTitle(note)}
                  {dirty.has(note) ? <span className="ml-1 text-[var(--fg-muted)]">·</span> : null}
                </button>
                <span className="hidden shrink-0 gap-2 group-focus-within:flex group-hover:flex">
                  <button type="button" className={rowAction} onClick={() => actions.onRename(note, "note")}>
                    Rename
                  </button>
                  <button type="button" className={rowAction} onClick={() => actions.onDelete(note, "note")}>
                    Delete
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </>
    );
  }

  return (
    <>
      {allFolders.length > 0 ? (
        <div className="flex gap-4 px-4 pt-3">
          <button
            type="button"
            className={`${rowAction} disabled:opacity-40`}
            disabled={allCollapsed}
            onClick={() => setCollapsed(new Set(allFolders))}
          >
            Collapse all
          </button>
          <button
            type="button"
            className={`${rowAction} disabled:opacity-40`}
            disabled={noneCollapsed}
            onClick={() => setCollapsed(new Set())}
          >
            Expand all
          </button>
        </div>
      ) : null}
      <ul ref={list} className="py-2">
        {renderFolder(tree, 0)}
      </ul>
    </>
  );
}
