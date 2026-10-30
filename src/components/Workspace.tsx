import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { computeBlankScore } from "../lib/blankScore";
import { clearDraft, loadDraft, loadPrefs, resolveInitialTheme, savePrefs } from "../lib/storage";
import { NOTE_EXT, noteTitle, parentOf, useVault, type SyncStatus } from "../lib/vaultSync";
import { renderMarkdown, resolveLink } from "../lib/wikilinks";
import { readMarkdownZip } from "../lib/importZip";
import { noteHash, noteUrl, readNoteHash } from "../lib/noteLink";
import { outline, type Heading } from "../lib/outline";
import { fetchBacklinks, searchNotes, type SearchHit } from "../lib/searchApi";
import type { FontName, ThemeName } from "../types";
import { FileTree } from "./FileTree";
import { ProfilePage } from "./ProfilePage";
import type { EditorControl } from "./NoteEditor";
import { FontSwitch } from "./FontSwitch";
import { FONT_CLASS } from "../fonts";
import { PublishPanel } from "./PublishPanel";
import { QuickSwitcher } from "./QuickSwitcher";
import { ThemeSwitch } from "./ThemeSwitch";
import { Wordmark } from "./Wordmark";

// The editor (CodeMirror) is most of the app's weight; load it only when a
// note is opened, so sign-in and published pages stay light.
const NoteEditor = lazy(() => import("./NoteEditor").then((m) => ({ default: m.NoteEditor })));

const PROFILE_HASH = "#profile";

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
  // Guests (anonymous sign-ins) keep their notes at the top level and can't
  // publish; supabase/guests.sql enforces the same on the server.
  const guest = session.user.is_anonymous === true;
  const { vault, snapshot } = useVault(userId);
  const { notes, folders, versions, status, notice } = snapshot;

  // A note's link (#note=…) wins over the note that was open last time.
  const [selected, setSelected] = useState<string | null>(
    () => readNoteHash() ?? localStorage.getItem(lastNoteKey(userId))
  );
  const [reveal, setReveal] = useState<{ path: string } | null>(() => {
    const linked = readNoteHash();
    return linked ? { path: linked } : null;
  });
  const [linkCopied, setLinkCopied] = useState(false);
  // The profile page has its own address (#profile) so Back returns to notes.
  const [page, setPage] = useState<"notes" | "profile">(() =>
    window.location.hash === PROFILE_HASH ? "profile" : "notes"
  );
  const [reading, setReading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<ThemeName>(resolveInitialTheme);
  const [font, setFont] = useState<FontName>(() => loadPrefs().font);
  const [showPasted, setShowPasted] = useState(() => loadPrefs().showPasted);
  const [showToc, setShowToc] = useState(() => loadPrefs().showToc);
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1024);
  const editorControl = useRef<EditorControl | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const importedDraft = useRef(false);
  const zipInput = useRef<HTMLInputElement>(null);

  const paths = useMemo(() => Object.keys(notes), [notes]);
  const listed = selected ? notes[selected] : undefined;
  // Only an opened (downloaded) note can be shown or edited.
  const note = listed?.loaded ? listed : undefined;
  const loaded = status !== "loading";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    savePrefs({ theme, font, showPasted, showToc });
  }, [theme, font, showPasted, showToc]);

  useEffect(() => {
    if (selected) localStorage.setItem(lastNoteKey(userId), selected);
  }, [selected, userId]);

  // A note can vanish under us (deleted or renamed on another device), or a
  // link can point at one that isn't there.
  useEffect(() => {
    if (!loaded || !selected || notes[selected]) return;
    if (readNoteHash() === selected) setError(`“${noteTitle(selected)}” isn't in your vault.`);
    setSelected(null);
  }, [loaded, selected, notes]);

  // The address bar always shows the open note's link (or the profile's).
  // Opening a note adds a history entry (see open); renames and the like
  // just correct it.
  useEffect(() => {
    const hash = page === "profile" ? PROFILE_HASH : selected ? noteHash(selected) : "";
    if (window.location.hash !== hash) {
      history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
    setLinkCopied(false);
  }, [selected, page]);

  // Back/forward, or a link pasted into the address bar.
  useEffect(() => {
    function onHashChange() {
      if (window.location.hash === PROFILE_HASH) {
        setPage("profile");
        return;
      }
      setPage("notes");
      const linked = readNoteHash();
      if (!linked) return;
      setSelected(linked);
      setReveal({ path: linked });
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const open = useCallback((path: string) => {
    if (window.location.hash !== noteHash(path)) history.pushState(null, "", noteHash(path));
    setPage("notes");
    setSelected(path);
    setReading(false);
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);

  const createNote = useCallback(
    (folder: string, title = "Untitled") => {
      const name = cleanName(title) ?? "Untitled";
      open(vault.createNote(join(guest ? "" : folder, `${name}${NOTE_EXT}`)));
    },
    [vault, open, guest]
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

  async function importZip(file: File) {
    setError(null);
    let parsed;
    try {
      parsed = readMarkdownZip(new Uint8Array(await file.arrayBuffer()));
    } catch {
      setError(`“${file.name}” couldn't be read as a zip file.`);
      return;
    }
    if (parsed.notes.length === 0) {
      setError(`No Markdown notes found in “${file.name}”.`);
      return;
    }
    // Guests have no folders, so everything lands at the top level.
    const notesToAdd = guest
      ? parsed.notes.map((n) => ({ ...n, path: n.path.slice(n.path.lastIndexOf("/") + 1) }))
      : parsed.notes;
    const created = vault.importNotes(notesToAdd);
    if (!guest) {
      for (const folder of parsed.emptyFolders) {
        if (!vault.pathExists(folder)) run(vault.createFolder(folder));
      }
    }
    open(created[0]);
    if (parsed.skipped > 0) {
      setError(`Imported ${created.length} notes; skipped ${parsed.skipped} files that aren't Markdown.`);
    }
  }

  // Shows the open note in the sidebar: folders opened, scrolled to, flashed.
  function locate() {
    if (!selected) return;
    setQuery("");
    setSidebarOpen(true);
    setReveal({ path: selected });
  }

  async function copyLink() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(noteUrl(selected));
      setLinkCopied(true);
    } catch {
      setError("Couldn't copy the link.");
    }
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

  function openProfile() {
    if (window.location.hash !== PROFILE_HASH) history.pushState(null, "", PROFILE_HASH);
    setPage("profile");
  }

  function closeProfile() {
    history.pushState(null, "", selected ? noteHash(selected) : window.location.pathname);
    setPage("notes");
  }

  async function signOut() {
    if (guest && !window.confirm("You're writing without an account. Signing out loses these notes for good. Sign out?")) {
      return;
    }
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

  const dirty = useMemo(() => new Set(Object.values(notes).filter((n) => n.dirty).map((n) => n.path)), [notes]);
  const previewHtml = useMemo(
    () => (reading && note ? renderMarkdown(note.body, paths) : ""),
    [reading, note, paths]
  );

  const charCount = note?.body.length ?? 0;
  const wordCount = !note || note.body.trim() === "" ? 0 : note.body.trim().split(/\s+/).length;
  const score = note ? computeBlankScore(note.stats, charCount).score : 0;
  const noteBody = note?.body;
  const headings = useMemo(() => (noteBody === undefined ? [] : outline(noteBody)), [noteBody]);

  // Contents entries go to the heading in whichever view is showing.
  function jumpToHeading(heading: Heading, index: number) {
    if (reading) {
      articleRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6")[index]?.scrollIntoView({ block: "start" });
    } else {
      editorControl.current?.jumpTo(heading.from);
    }
    if (window.innerWidth < 1024) setDetailsOpen(false);
  }

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
          {note && !guest && page === "notes" ? (
            <button
              type="button"
              onClick={() => setPublishOpen(true)}
              className="rounded-sm border border-[var(--fg)] px-3 py-1.5 font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Publish
            </button>
          ) : null}
          <button
            type="button"
            onClick={page === "profile" ? closeProfile : openProfile}
            aria-pressed={page === "profile"}
            className={headerButton}
          >
            Profile
          </button>
          <button type="button" onClick={signOut} className={headerButton} title={session.user.email ?? ""}>
            {guest ? "Guest · Sign out" : "Sign out"}
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
        {page === "profile" ? (
          <ProfilePage
            session={session}
            guest={guest}
            theme={theme}
            onTheme={setTheme}
            font={font}
            onFont={setFont}
            showPasted={showPasted}
            onShowPasted={setShowPasted}
            showToc={showToc}
            onShowToc={setShowToc}
            onClose={closeProfile}
          />
        ) : (
          <>
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
                {guest ? null : (
                  <button type="button" className={headerButton} onClick={newFolder}>
                    + Folder
                  </button>
                )}
                <button type="button" className={headerButton} onClick={() => zipInput.current?.click()}>
                  Import
                </button>
                <input
                  ref={zipInput}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // let the same file be picked again
                    if (file) importZip(file);
                  }}
                />
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
                  reveal={reveal}
                  actions={{ onOpen: open, onNewNote: (f) => createNote(f), onRename: rename, onDelete: remove }}
                />
              )}
            </nav>
            <div className="flex flex-col gap-3 border-t border-[var(--rule)] p-3 lg:hidden">
              <FontSwitch value={font} onChange={setFont} />
              <ThemeSwitch value={theme} onChange={setTheme} />
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
                <div className="flex shrink-0 items-center gap-4">
                  <button type="button" className={headerButton} onClick={locate} title="Show in the sidebar">
                    Locate
                  </button>
                  <button type="button" className={headerButton} onClick={copyLink} title={noteUrl(selected)}>
                    {linkCopied ? "Copied" : "Link"}
                  </button>
                  <button
                    type="button"
                    className={headerButton}
                    onClick={() => setDetailsOpen((o) => !o)}
                    aria-expanded={detailsOpen}
                    title="Stats and contents"
                  >
                    Details
                  </button>
                  <button type="button" className={headerButton} onClick={() => setReading((r) => !r)}>
                    {reading ? "Write" : "Read"}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={locate}
                title="Show in the sidebar"
                className="mt-1 self-start font-write-mono text-[11px] text-[var(--fg-muted)] hover:text-[var(--accent)]"
              >
                {parentOf(selected) ? parentOf(selected).split("/").join(" / ") : "Vault"} / {noteTitle(selected)}
              </button>

              <div className="mt-8 flex-1">
                {reading ? (
                  <article
                    ref={articleRef}
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
                  <Suspense fallback={null}>
                    <NoteEditor
                      key={`${selected}#${versions[selected] ?? 0}`}
                      note={note}
                      font={font}
                      showPasted={showPasted}
                      paths={paths}
                      controlRef={editorControl}
                      onFollowLink={followLink}
                      onChange={(body, stats, ranges) => vault.updateNote(selected, body, stats, ranges)}
                    />
                  </Suspense>
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

        {note && selected && detailsOpen ? (
          <aside className="fixed inset-y-0 right-0 z-10 flex w-[min(288px,100%)] flex-col overflow-auto border-l border-[var(--rule)] bg-[var(--surface)] lg:static lg:z-auto lg:w-64 lg:shrink-0">
            <div className="flex items-center justify-between border-b border-[var(--rule)] px-5 py-3 lg:hidden">
              <span className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">Details</span>
              <button type="button" className={headerButton} onClick={() => setDetailsOpen(false)}>
                Close
              </button>
            </div>

            <section className="border-b border-[var(--rule)] p-5">
              <div className="font-write-mono text-3xl leading-none tabular-nums text-[var(--fg)]">
                {charCount === 0 || note.imported ? "—" : score.toFixed(1)}
              </div>
              <div className="mt-2 font-write-mono text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
                {note.imported ? "imported · no blank score" : "blank score"}
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-y-2 font-write-mono text-[12px]">
                <dt className="text-[var(--fg-muted)]">Words</dt>
                <dd className="text-right tabular-nums">{wordCount}</dd>
                <dt className="text-[var(--fg-muted)]">Characters</dt>
                <dd className="text-right tabular-nums">{charCount}</dd>
                {note.imported ? null : (
                  <>
                    <dt className="text-[var(--fg-muted)]">Pasted</dt>
                    <dd className="text-right tabular-nums">{note.stats.pastedChars}</dd>
                  </>
                )}
              </dl>
              <button
                type="button"
                onClick={() => setShowPasted((s) => !s)}
                aria-pressed={showPasted}
                title="Highlighting only — pasted text counts toward the Blank Score either way"
                className={`${headerButton} mt-4`}
              >
                Highlight pasted: {showPasted ? "on" : "off"}
              </button>
            </section>

            <section className="p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-write-mono text-[11px] uppercase tracking-wide text-[var(--fg-muted)]">Contents</h2>
                <button
                  type="button"
                  onClick={() => setShowToc((s) => !s)}
                  aria-expanded={showToc}
                  className={headerButton}
                >
                  {showToc ? "Hide" : "Show"}
                </button>
              </div>
              {showToc ? (
                headings.length === 0 ? (
                  <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-muted)]">
                    No headings yet. Start a line with # to add one.
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {headings.map((heading, i) => (
                      <li key={`${heading.from}`} style={{ paddingLeft: (heading.level - 1) * 12 }}>
                        <button
                          type="button"
                          onClick={() => jumpToHeading(heading, i)}
                          className={`text-left text-[13px] leading-snug hover:text-[var(--accent)] ${
                            heading.level === 1 ? "text-[var(--fg)]" : "text-[var(--fg-muted)]"
                          }`}
                        >
                          {heading.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </section>
          </aside>
        ) : null}
          </>
        )}
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

      {note && !guest ? (
        <PublishPanel
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          getSnapshot={() => ({ content: note.body, stats: { ...note.stats }, imported: note.imported === true })}
          theme={theme}
          font={font}
        />
      ) : null}
    </div>
  );
}
