import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { computeBlankScore } from "../lib/blankScore";
import { clearDraft, loadDraft, loadPrefs, resolveInitialTheme, savePrefs } from "../lib/storage";
import { NOTE_EXT, noteTitle, parentOf, useVault, type SyncStatus } from "../lib/vaultSync";
import { renderMarkdown, resolveLink } from "../lib/wikilinks";
import { fetchBacklinks, rebuildIndex, searchNotes, type SearchHit } from "../lib/searchApi";
import type { FontName, ThemeName } from "../types";
import { FileTree } from "./FileTree";
import { FontSwitch } from "./FontSwitch";
import { FONT_CLASS, NoteEditor } from "./NoteEditor";
import { PublishPanel } from "./PublishPanel";
import { QuickSwitcher } from "./QuickSwitcher";
import { ThemeSwitch } from "./ThemeSwitch";
import { Wordmark } from "./Wordmark";

const SYNC_LABEL: Record<SyncStatus, string> = {
  loading: "Loading vault…",
  synced: "Synced",
  saving: "Syncing…",
  offline: "Offline — will retry",
  error: "Sync error — retrying",
};

const headerButton =
  "font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)] hover:text-[var(--fg)]";

function lastNoteKey(userId: string) {
  return `startblank.lastNote.${userId}`;
}

// Names become file names, so keep them to one path segment and nothing
// a file system would choke on.
function cleanName(raw: string | null): string | null {
  const name = raw?.trim().replace(/[\\/]/g, "-");
  if (!name || name.startsWith(".")) return null;
  return name;
}

function join(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name;
}

export function Workspace({ session }: { session: Session }) {
  const userId = session.user.id;
  const { vault, snapshot } = useVault(userId);
  const { notes, folders, versions, status, notice } = snapshot;

  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(lastNoteKey(userId)));
  const [reading, setReading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<ThemeName>(resolveInitialTheme);
  const [font, setFont] = useState<FontName>(() => loadPrefs().font);
  const [error, setError] = useState<string | null>(null);
  const importedDraft = useRef(false);

  const paths = useMemo(() => Object.keys(notes), [notes]);
  const listed = selected ? notes[selected] : undefined;
  // Only an opened (downloaded) note can be shown or edited.
  const note = listed?.loaded ? listed : undefined;
  const loaded = status !== "loading";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    savePrefs({ theme, font });
  }, [theme, font]);

  useEffect(() => {
    if (selected) localStorage.setItem(lastNoteKey(userId), selected);
  }, [selected, userId]);

  // A note can vanish under us (deleted or renamed on another device).
  useEffect(() => {
    if (loaded && selected && !notes[selected]) setSelected(null);
  }, [loaded, selected, notes]);

  const open = useCallback((path: string) => {
    setSelected(path);
    setReading(false);
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);

  const createNote = useCallback(
    (folder: string, title = "Untitled") => {
      const name = cleanName(title) ?? "Untitled";
      open(vault.createNote(join(folder, `${name}${NOTE_EXT}`)));
    },
    [vault, open]
  );

  // Carry over a draft written in the old single-page version of the app,
  // keeping its hand-writing record.
  useEffect(() => {
    if (!loaded || importedDraft.current) return;
    importedDraft.current = true;
    const draft = loadDraft();
    if (!draft || draft.content.trim() === "") return;
    const path = vault.createNote(`Draft${NOTE_EXT}`, {
      body: draft.content,
      stats: draft.stats,
      pasteRanges: draft.pasteRanges,
    });
    clearDraft();
    open(path);
  }, [loaded, vault, open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setSwitcherOpen(true);
      } else if (mod && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setReading((r) => !r);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function run(action: Promise<unknown>) {
    setError(null);
    try {
      await action;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  function rename(path: string, kind: "note" | "folder") {
    const current = kind === "note" ? noteTitle(path) : path.slice(path.lastIndexOf("/") + 1);
    const name = cleanName(window.prompt(`Rename ${kind}`, current));
    if (!name || name === current) return;
    const target = join(parentOf(path), kind === "note" ? `${name}${NOTE_EXT}` : name);
    if (kind === "note") {
      run(vault.renameNote(path, target).then(() => selected === path && setSelected(target)));
    } else {
      run(
        vault.renameFolder(path, target).then(() => {
          if (selected?.startsWith(`${path}/`)) setSelected(`${target}${selected.slice(path.length)}`);
        })
      );
    }
  }

  function remove(path: string, kind: "note" | "folder") {
    const label = kind === "note" ? `“${noteTitle(path)}”` : `the folder “${path}” and every note in it`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    run(kind === "note" ? vault.deleteNote(path) : vault.deleteFolder(path));
  }

  function newFolder() {
    const name = cleanName(window.prompt("New folder name"));
    if (!name) return;
    const target = join(selected ? parentOf(selected) : "", name);
    if (vault.pathExists(target)) {
      setError("Something with that name already exists.");
      return;
    }
    run(vault.createFolder(target));
  }

  function renameFromTitle(value: string) {
    if (!selected) return;
    const name = cleanName(value);
    if (!name || name === noteTitle(selected)) return;
    const target = join(parentOf(selected), `${name}${NOTE_EXT}`);
    run(vault.renameNote(selected, target).then(() => setSelected(target)));
  }

  function followLink(target: string) {
    const resolved = resolveLink(target, paths);
    if (resolved) {
      open(resolved);
      return;
    }
    const folder = parentOf(target);
    createNote(folder, target.slice(folder ? folder.length + 1 : 0));
  }

  async function signOut() {
    try {
      await vault.flushNow();
    } catch {
      if (!window.confirm("Some changes haven't reached the server yet. Sign out anyway and lose them?")) return;
    }
    await supabase.auth.signOut();
  }

  // Searching runs on the server; notes with edits it hasn't indexed yet
  // are matched locally and listed first.
  const [serverHits, setServerHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setServerHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchNotes(q)
        .then((hits) => !cancelled && setServerHits(hits))
        .catch(() => !cancelled && setServerHits([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const local: SearchHit[] = Object.values(notes)
      .filter((n) => n.dirty && (noteTitle(n.path).toLowerCase().includes(q) || n.body.toLowerCase().includes(q)))
      .map((n) => ({ path: n.path, title: noteTitle(n.path), excerpt: n.body.slice(0, 160) }));
    const seen = new Set(local.map((h) => h.path));
    const remote = (serverHits ?? []).filter((h) => notes[h.path] && !seen.has(h.path));
    return [...local, ...remote];
  }, [notes, query, serverHits]);

  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [backlinkTick, setBacklinkTick] = useState(0);
  useEffect(() => {
    const bump = () => setBacklinkTick((t) => t + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, []);
  useEffect(() => {
    setBacklinks([]);
    if (!selected) return;
    let cancelled = false;
    fetchBacklinks(selected)
      .then((paths) => !cancelled && setBacklinks(paths))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected, backlinkTick]);

  useEffect(() => {
    if (selected && listed && !listed.loaded) {
      vault.ensureLoaded(selected).catch(() => setError("Couldn't open that note — check your connection."));
    }
  }, [vault, selected, listed]);

  async function rebuildSearch() {
    setError(null);
    try {
      const count = await rebuildIndex();
      setError(`Search index rebuilt from ${count} ${count === 1 ? "note" : "notes"}.`);
    } catch {
      setError("Couldn't rebuild the search index — is the index-note function deployed?");
    }
  }

  const dirty = useMemo(() => new Set(Object.values(notes).filter((n) => n.dirty).map((n) => n.path)), [notes]);
  const previewHtml = useMemo(
    () => (reading && note ? renderMarkdown(note.body, paths) : ""),
    [reading, note, paths]
  );

  const charCount = note?.body.length ?? 0;
  const wordCount = !note || note.body.trim() === "" ? 0 : note.body.trim().split(/\s+/).length;
  const score = note ? computeBlankScore(note.stats, charCount).score : 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--rule)] px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <button
            type="button"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label={sidebarOpen ? "Hide notes" : "Show notes"}
            aria-expanded={sidebarOpen}
            className={headerButton}
          >
            {sidebarOpen ? "Hide" : "Notes"}
          </button>
          <Wordmark />
        </div>
        <div className="flex items-center gap-4 sm:gap-6">
          <span className="hidden font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)] sm:inline">
            {SYNC_LABEL[status]}
          </span>
          <div className="hidden items-center gap-6 lg:flex">
            <FontSwitch value={font} onChange={setFont} />
            <div className="h-4 w-px bg-[var(--rule)]" />
            <ThemeSwitch value={theme} onChange={setTheme} />
            <div className="h-4 w-px bg-[var(--rule)]" />
          </div>
          {note ? (
            <button
              type="button"
              onClick={() => setPublishOpen(true)}
              className="rounded-sm border border-[var(--fg)] px-3 py-1.5 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Publish
            </button>
          ) : null}
          <button type="button" onClick={signOut} className={headerButton} title={session.user.email ?? ""}>
            Sign out
          </button>
        </div>
      </header>

      {notice || error ? (
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--rule)] bg-[var(--surface)] px-6 py-2 text-[13px] text-[var(--fg)]">
          <span>{error ?? notice}</span>
          <button
            type="button"
            className={headerButton}
            onClick={() => (error ? setError(null) : vault.dismissNotice())}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? (
          <aside className="flex w-full shrink-0 flex-col border-r border-[var(--rule)] bg-[var(--surface)] md:w-72">
            <div className="flex flex-col gap-3 border-b border-[var(--rule)] p-3">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes"
                className="w-full border border-[var(--rule)] bg-transparent px-2.5 py-1.5 font-write-mono text-[12px] text-[var(--fg)] focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className={headerButton}
                  onClick={() => createNote(selected ? parentOf(selected) : "")}
                >
                  + Note
                </button>
                <button type="button" className={headerButton} onClick={newFolder}>
                  + Folder
                </button>
                <button type="button" className={`${headerButton} ml-auto`} onClick={() => setSwitcherOpen(true)}>
                  Open ⌘O
                </button>
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-auto">
              {!loaded ? (
                <p className="p-4 text-[13px] text-[var(--fg-muted)]">Loading…</p>
              ) : searchResults ? (
                <ul className="py-2">
                  {searchResults.length === 0 ? (
                    <li className="px-4 py-2 text-[13px] text-[var(--fg-muted)]">
                      {serverHits === null ? "Searching…" : "No matches."}
                    </li>
                  ) : (
                    searchResults.map((hit) => (
                      <li key={hit.path}>
                        <button
                          type="button"
                          onClick={() => open(hit.path)}
                          className="flex w-full flex-col gap-0.5 px-4 py-2 text-left"
                        >
                          <span className="truncate text-[13px] text-[var(--fg)]">{hit.title}</span>
                          {parentOf(hit.path) ? (
                            <span className="truncate font-write-mono text-[10px] text-[var(--fg-muted)]">
                              {parentOf(hit.path)}
                            </span>
                          ) : null}
                          {hit.excerpt ? (
                            <span className="line-clamp-2 text-[12px] leading-snug text-[var(--fg-muted)]">
                              {hit.excerpt}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              ) : (
                <FileTree
                  folders={folders}
                  notes={paths}
                  dirty={dirty}
                  selected={selected}
                  actions={{ onOpen: open, onNewNote: (f) => createNote(f), onRename: rename, onDelete: remove }}
                />
              )}
            </nav>
            <div className="flex flex-col gap-3 border-t border-[var(--rule)] p-3">
              <div className="flex flex-col gap-3 lg:hidden">
                <FontSwitch value={font} onChange={setFont} />
                <ThemeSwitch value={theme} onChange={setTheme} />
              </div>
              <button type="button" className={`${headerButton} self-start`} onClick={rebuildSearch}>
                Rebuild search index
              </button>
            </div>
          </aside>
        ) : null}

        <main
          className={`min-w-0 flex-1 overflow-auto ${sidebarOpen ? "hidden md:block" : "block"}`}
        >
          {note && selected ? (
            <div className="mx-auto flex min-h-full max-w-[720px] flex-col px-6 pt-10">
              <div className="flex items-center justify-between gap-4">
                <input
                  key={selected}
                  defaultValue={noteTitle(selected)}
                  onBlur={(e) => renameFromTitle(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  aria-label="Note title"
                  className={`${FONT_CLASS[font]} min-w-0 flex-1 border-none bg-transparent text-2xl text-[var(--fg)] focus:outline-none`}
                />
                <button type="button" className={headerButton} onClick={() => setReading((r) => !r)}>
                  {reading ? "Write" : "Read"}
                </button>
              </div>
              {parentOf(selected) ? (
                <p className="mt-1 font-write-mono text-[11px] text-[var(--fg-muted)]">{parentOf(selected)}</p>
              ) : null}

              <div className="mt-8 flex-1">
                {reading ? (
                  <article
                    className={`${FONT_CLASS[font]} note-preview`}
                    onClick={(event) => {
                      const link = (event.target as HTMLElement).closest("a");
                      if (!link) return;
                      event.preventDefault();
                      const target = link.dataset.target;
                      if (target) followLink(target);
                      else if (link.href) window.open(link.href, "_blank", "noopener,noreferrer");
                    }}
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                ) : (
                  <NoteEditor
                    key={`${selected}#${versions[selected] ?? 0}`}
                    note={note}
                    font={font}
                    onChange={(body, stats, ranges) => vault.updateNote(selected, body, stats, ranges)}
                  />
                )}
              </div>

              <section className="mt-12 border-t border-[var(--rule)] py-6">
                <h2 className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
                  Linked mentions · {backlinks.length}
                </h2>
                {backlinks.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {backlinks.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          onClick={() => open(path)}
                          className="text-left text-[14px] text-[var(--accent)] underline-offset-4 hover:underline"
                        >
                          {noteTitle(path)}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <footer className="sticky bottom-0 -mx-6 flex items-end justify-between border-t border-[var(--rule)] bg-[var(--bg)] px-6 py-3">
                <div>
                  <div className="font-write-mono text-xl leading-none tabular-nums text-[var(--fg)]">{charCount}</div>
                  <div className="mt-1 font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
                    characters · {wordCount} {wordCount === 1 ? "word" : "words"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-write-mono text-xl leading-none tabular-nums text-[var(--fg)]">
                    {charCount === 0 ? "—" : score.toFixed(1)}
                  </div>
                  <div className="mt-1 font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
                    blank score
                  </div>
                </div>
              </footer>
            </div>
          ) : listed ? (
            <p className="mx-auto max-w-[720px] px-6 pt-10 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">
              Opening {noteTitle(listed.path)}…
            </p>
          ) : (
            <div className="mx-auto flex max-w-[420px] flex-col items-start gap-4 px-6 pt-24">
              <p className="font-write-typewriter text-xl text-[var(--fg)]">
                {loaded ? (paths.length === 0 ? "An empty vault." : "No note open.") : "Loading your vault…"}
              </p>
              {loaded ? (
                <>
                  <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                    Every note is a Markdown file synced to your account. Write it
                    yourself — pasted text is marked, and the Blank Score keeps count.
                  </p>
                  <button
                    type="button"
                    onClick={() => createNote("")}
                    className="rounded-sm border border-[var(--fg)] px-4 py-2 font-write-mono text-[12px] uppercase tracking-wide text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    New note
                  </button>
                </>
              ) : null}
            </div>
          )}
        </main>
      </div>

      {switcherOpen ? (
        <QuickSwitcher
          paths={paths}
          onOpen={(path) => {
            setSwitcherOpen(false);
            open(path);
          }}
          onCreate={(title) => {
            setSwitcherOpen(false);
            createNote("", title);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}

      {note ? (
        <PublishPanel
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          getSnapshot={() => ({ content: note.body, stats: { ...note.stats } })}
          theme={theme}
          font={font}
        />
      ) : null}
    </div>
  );
}
