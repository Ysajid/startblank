-- startblank vault: notes in Postgres.
--
-- Applied by `npm run migrate`, connected as the database owner. The server
-- itself connects as `startblank_app`, a role that owns nothing and is
-- subject to row-level security: every request runs in a transaction with
-- `app.user_id` set to the signed-in user, and the policies below make
-- other users' rows invisible — even to a query that forgets to filter.

-- ---- Notes -------------------------------------------------------------------

create table notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  -- Vault-relative path, e.g. "Ideas/On walking.md"; folders are prefixes.
  path text not null,
  title text not null,
  body text not null,
  -- The app's hand-writing record for this body (JSON, see
  -- src/lib/noteFile.ts). Saved in the same row, so the two can never
  -- drift apart.
  record text,
  -- Lower-cased [[link]] targets, for backlinks.
  links text[] not null default '{}',
  -- Bumped on every content change; saves must name the version they
  -- started from, so nothing is ever silently overwritten.
  version bigint not null default 1,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 'simple': no stemming or stop words, so every language is searchable.
  search tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', left(body, 500000)), 'B')
  ) stored,
  unique (owner_id, path)
);

create index notes_search_idx on notes using gin (search);
create index notes_links_idx on notes using gin (links);

-- ---- Folders -------------------------------------------------------------------
-- Folders that exist on their own (possibly empty). Folders that contain
-- notes exist implicitly through the notes' paths.

create table folders (
  owner_id uuid not null,
  path text not null,
  primary key (owner_id, path)
);

-- ---- Revisions ---------------------------------------------------------------------
-- Who wrote what, and when. Saves by the same author in quick succession
-- (autosave while typing) are folded into one revision.

create table note_revisions (
  id bigint generated always as identity primary key,
  note_id uuid not null references notes (id) on delete cascade,
  owner_id uuid not null,
  version bigint not null,
  body text not null,
  -- "app" for the signed-in user typing in startblank; "agent:<name>" for
  -- AI tools writing through the connector.
  author text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index note_revisions_note_idx on note_revisions (note_id, id desc);

-- ---- Row-level security --------------------------------------------------------------

create or replace function current_vault_user() returns uuid
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

alter table notes enable row level security;
alter table notes force row level security;
alter table folders enable row level security;
alter table folders force row level security;
alter table note_revisions enable row level security;
alter table note_revisions force row level security;

create policy own_notes on notes
  using (owner_id = current_vault_user())
  with check (owner_id = current_vault_user());
create policy own_folders on folders
  using (owner_id = current_vault_user())
  with check (owner_id = current_vault_user());
create policy own_revisions on note_revisions
  using (owner_id = current_vault_user())
  with check (owner_id = current_vault_user());

grant usage on schema public to startblank_app;
grant select, insert, update, delete on notes, folders, note_revisions to startblank_app;
grant execute on function current_vault_user() to startblank_app;
