import { useState } from "react";
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
  actions,
}: {
  folders: string[];
  notes: string[];
  dirty: Set<string>;
  selected: string | null;
  actions: TreeActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = buildTree(folders, notes);

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
                className={`group flex items-center justify-between gap-2 py-1 pr-2 ${
                  isSelected ? "bg-[var(--rule)]" : ""
                }`}
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

  return <ul className="py-2">{renderFolder(tree, 0)}</ul>;
}
