# Startblank — Project Plan

## 1. Vision

A distraction-free writing tool: one blank page, nothing else. You write, you
finish, you get a read-only link to share. Behind the scenes, the app scores
*how* the text was produced — rewarding genuine typing and revision, and
discounting copy-paste — as a "Blank Score."

## 2. Goals

- The best possible plain-text writing surface: no clutter, fast, calm.
- Personalization that doesn't get in the way: theme (light / dark / sepia)
  and font choice, persisted per user/browser.
- One-click publish: turn the current draft into a permanent, view-only,
  shareable link.
- A transparent, gameable-but-honest "Blank Score" that signals how much of
  a piece was actually written (vs. pasted) by its author.

## 3. Non-Goals (v1)

- No real-time collaboration / multiplayer editing.
- No accounts required to write or share (anonymous by default).
- No rich formatting (bold/italic/images) — plain text only, to keep the
  writing signal (keystrokes vs. paste) unambiguous.
- No editing of a document after it has been published to a share link
  (published = frozen snapshot).

## 4. Core Features

### 4.1 The writing page
- Single centered text area, generous line height/margins, no toolbar.
- Autosave to local storage as the user types (draft recovery on reload).
- Live word/character count, unobtrusive (corner, low contrast).

### 4.2 Theme
- Light, Dark, Sepia. Toggle in a corner menu, applied instantly via CSS
  variables. Persisted in `localStorage`.

### 4.3 Font selection
- A small curated set (e.g. a serif, a sans, and a monospace — 3-5 options
  total, not an open web-font picker) to keep the surface simple.
- Persisted in `localStorage`.

### 4.4 Publish / Share
- "Publish" button finalizes the current draft: computes final stats +
  Blank Score, stores an immutable snapshot server-side, returns a
  short-slug URL (e.g. `startblank.app/s/x7f2q`).
- The share view is read-only: rendered text, theme it was written in, and
  the Blank Score badge. No edit affordance, no way to discover other
  documents (slugs are unguessable, not listed/indexed).

## 5. The Blank Score

### 5.1 What we're measuring

While the user writes, the client instruments four raw signals:

| Signal | Definition |
|---|---|
| `K` (keystrokes) | Character-producing key presses (typing), excluding paste-inserted text |
| `E` (edits) | Backspace/delete presses, plus retyping over a selection (corrections & revisions) |
| `P` / `Pc` | Number of paste events, and total characters inserted via paste |
| `L` | Final character count of the published document |

These are counted client-side as the user types (keydown/input event
listeners) and submitted alongside the final text on publish. We only need
counts, never keystroke *content* or timing — so no keylogging-style replay
of what was typed, which matters for user trust.

### 5.2 The formula

Two intermediate ratios:

- **Organic Ratio** — how much of the "input effort" was typed vs. pasted:
  `OR = K / (K + Pc)`  → 1.0 if 100% typed, 0.0 if 100% pasted.

- **Paste Reliance** — how much of the *final* document is literally
  pasted-in text:
  `PR = Pc / L`  → 0 if nothing pasted, approaches 1 if the doc is mostly paste.

- **Revision Density** — how much correction/editing happened relative to
  the size of the finished piece (signal that the author refined their
  work rather than dumping a first draft):
  `RD = E / L`

Revision credit, with a **0.9 baseline** for clean, unedited typing —
simply writing your own words already scores highly — and only a small
additional 0.1 available from editing, capped so editing can't run away
with the score:

  `f(RD) = min(1, 0.9 + 0.1 × RD)`

**Blank Score** (0–100):

  `BlankScore = 100 × OR × (1 − min(PR, 1)) × f(RD)`

### 5.3 Why this shape

- Multiplying (rather than averaging) `OR` and `(1 − PR)` means heavy
  pasting tanks the score regardless of how much editing happened around
  it — you can't paste a paragraph and edit your way to a high score.
- `f(RD)` gives a high floor (90/100) to anyone who types their own words
  with no paste at all — that's the primary signal of "purity." Editing on
  top of that is real but secondary: it can only add another 10 points,
  reaching the full 100 once edits are at least as numerous as the final
  document's length (`RD ≥ 1`). Editing nudges the score, it doesn't
  define it.
- Everything is derived from *counts*, not content, so it's cheap to
  compute, doesn't require storing keystroke logs, and is easy to display
  or explain to the user.

### 5.4 Worked examples

| Scenario | K | E | Pc | L | OR | PR | RD | Score |
|---|---|---|---|---|---|---|---|---|
| Typed clean, no edits, no paste | 500 | 0 | 0 | 500 | 1.0 | 0 | 0 | 90 |
| Typed & fully revised, no paste | 500 | 500 | 0 | 500 | 1.0 | 0 | 1.0 | 100 |
| Half pasted, rest typed & edited | 250 | 100 | 250 | 500 | 0.5 | 0.5 | 0.2 | 23 |
| Entirely pasted | 0 | 0 | 500 | 500 | 0 | 1.0 | 0 | 0 |

Reaching the full revision cap (`f(RD) = 1`) takes `E ≥ L` — at least as
many edits as the document's final length. Anything less lands somewhere
between 90 and 100, in proportion to `RD`.

### 5.5 Open calibration question

The constants (0.9 baseline, the 0.1 revision headroom, the multiplicative
shape) are a reasonable v1, not a law of nature. Plan is to ship this, log the raw
signals for real documents, and revisit weighting once we can see the
score distribution against pieces we can eyeball as "clearly copy-pasted"
vs. "clearly hand-written."

## 6. Data model

```
Document
  id            uuid (internal)
  slug          string (public, unguessable, ~8 chars)
  content       text (final, immutable once published)
  theme         enum(light|dark|sepia)  -- theme it was authored in
  font          enum(...)
  stats:
    keystrokes       int  (K)
    edits            int  (E)
    pasteEvents      int  (P)
    pastedChars      int  (Pc)
    finalLength      int  (L)
  blankScore    float (0-100, computed at publish time)
  createdAt     timestamp
```

No user accounts in v1 — a document is owned by whoever holds its slug
(and, if desired later, a locally-stored "edit token" for the author only,
used purely so an author's own browser can recognize "your published
pieces," not for auth).

## 7. Architecture (proposed)

- **Frontend**: single-page app (React/Next.js or plain Vite+React — no
  need for SSR beyond the share page). Client owns all instrumentation
  (keystroke/edit/paste counters) and localStorage for draft + prefs.
- **Backend**: minimal API — `POST /documents` (publish: takes final text +
  stats, computes score server-side so it can't be spoofed by a modified
  client, returns slug) and `GET /documents/:slug` (fetch for the read-only
  view). A small serverless function + Postgres (or SQLite for early days)
  is plenty; no need for anything heavier at this scale.
- **Security**: the share page renders user-supplied text — must be
  escaped/rendered as plain text (never `dangerouslySetInnerHTML` on raw
  content) to avoid stored XSS. Rate-limit publish to prevent spam/abuse of
  storage.

## 8. Milestones

1. **Scaffolding** — repo setup, framework choice, deploy pipeline.
2. **Writing surface** — the blank page, theme switcher, font picker,
   local autosave. (No backend yet — fully usable offline-first draft.)
3. **Instrumentation** — wire up keystroke/edit/paste counters client-side;
   surface a live (draft, unpublished) Blank Score for feedback.
4. **Publish & share** — backend endpoint, slug generation, read-only share
   view, server-side score computation.
5. **Polish** — mobile responsiveness, score badge design, empty/error
   states, basic analytics (docs published, score distribution).
6. **Calibration pass** — review real Blank Score data, tune formula
   constants if needed.

## 9. Open questions for the product owner

- Should published documents ever expire, or are they permanent?
- Any length limit on a single piece?
- Should the Blank Score be shown to the *writer* while drafting (as
  encouragement/gamification) or only revealed on publish?
- Any interest in an "edit token" so an author can find their own past
  published pieces without a full account system?
