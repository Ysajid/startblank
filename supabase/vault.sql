-- startblank: notes, folders and revision history
--
-- Run this once in the Supabase SQL editor, after schema.sql and
-- accounts.sql.
--
-- Each note is one row: its Markdown text and its hand-writing record (see
-- src/lib/noteFile.ts), saved together. Every table is private to its
-- owner through row-level security. Note text can only be written through
-- save_note(), which refuses a save that starts from an outdated version
-- (another device or an agent changed the note first) and records who
-- wrote what in note_revisions — so neither rule can be skipped by a
-- modified client.

-- ---- Notes ---------------------------------------------------------------------

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Vault-relative path like "Ideas/On walking.md"; folders are prefixes.
  -- Segments are non-empty, don't start with a dot, and contain no
  -- backslashes or control characters, so a vault always exports cleanly
  -- as a folder of Markdown files.
  path text not null check (
    char_length(path) <= 1024
    and path ~ '^[^/.\\[:cntrl:]][^/\\[:cntrl:]]*(/[^/.\\[:cntrl:]][^/\\[:cntrl:]]*)*$'
    and path ~* '\.md$'
  ),
  -- Set from path and body by the notes_derive trigger.
  title text not null default '',
  body text not null check (octet_length(body) <= 5242880),
  record text check (octet_length(record) <= 12582912),
  links text[] not null default '{}',
  -- Bumped on every content change; saves name the version they started
  -- from, so nothing is ever silently overwritten.
  version bigint not null default 1,
  updated_by text not null default 'app',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 'simple': no stemming or stop words, so every language is searchable.
  search tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', left(body, 500000)), 'B')
  ) stored,
  unique (owner_id, path)
);

create index if not exists notes_search_idx on public.notes using gin (search);
create index if not exists notes_links_idx on public.notes using gin (links);

-- Lower-cased [[link]] targets, ignoring links inside code (mirrors
-- src/lib/wikilinks.ts).
create or replace function public.note_links(p_body text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct lower(regexp_replace(trim(m[1]), '\.md$', '', 'i'))), '{}')
    from regexp_matches(
           regexp_replace(regexp_replace(p_body, '```.*?```', ' ', 'g'), '`[^`\n]*`', ' ', 'g'),
           '\[\[([^]\n|#]+)(#[^]\n|]*)?(\|[^]\n]+)?\]\]',
           'g'
         ) as m;
$$;

create or replace function public.notes_derive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := regexp_replace(regexp_replace(new.path, '^.*/', ''), '\.md$', '', 'i');
  if tg_op = 'INSERT' or new.body is distinct from old.body then
    new.links := public.note_links(new.body);
  end if;
  return new;
end;
$$;

drop trigger if exists notes_derive on public.notes;
create trigger notes_derive
  before insert or update on public.notes
  for each row execute function public.notes_derive();

-- ---- Folders ---------------------------------------------------------------------
-- Folders that exist on their own (possibly empty); folders that contain
-- notes exist through the notes' paths.

create table if not exists public.folders (
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path text not null check (
    char_length(path) <= 1024
    and path ~ '^[^/.\\[:cntrl:]][^/\\[:cntrl:]]*(/[^/.\\[:cntrl:]][^/\\[:cntrl:]]*)*$'
  ),
  primary key (owner_id, path)
);

-- ---- Revisions -------------------------------------------------------------------
-- Who wrote what, and when. Saves by the same author in quick succession
-- (autosave while typing) are folded into one revision.

create table if not exists public.note_revisions (
  id bigint generated always as identity primary key,
  note_id uuid not null references public.notes (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  version bigint not null,
  body text not null,
  -- "app" for the signed-in user typing in startblank; "agent:<name>" for
  -- AI tools (added with the agent connector).
  author text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists note_revisions_note_idx on public.note_revisions (note_id, id desc);
create index if not exists note_revisions_owner_idx on public.note_revisions (owner_id);

-- ---- Row-level security and privileges -------------------------------------------

alter table public.notes enable row level security;
alter table public.folders enable row level security;
alter table public.note_revisions enable row level security;

drop policy if exists "Own notes" on public.notes;
create policy "Own notes" on public.notes
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Own folders" on public.folders;
create policy "Own folders" on public.folders
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Own revisions" on public.note_revisions;
create policy "Own revisions" on public.note_revisions
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Text is written only through save_note(); directly, users may read,
-- delete, and rename (move) their notes.
revoke all on public.notes, public.folders, public.note_revisions from anon, authenticated;
grant select, delete on public.notes to authenticated;
grant update (path) on public.notes to authenticated;
grant select, insert, delete on public.folders to authenticated;
grant update (path) on public.folders to authenticated;
grant select on public.note_revisions to authenticated;

-- ---- Saving ----------------------------------------------------------------------

-- Saves a note's text and record together, as the signed-in user, only if
-- the note is still at p_base_version (null: only if it doesn't exist yet).
-- Returns the new version, or null if the note changed first — in which
-- case nothing was written.
create or replace function public.save_note(
  p_path text,
  p_body text,
  p_record text,
  p_base_version bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_id uuid;
  v_version bigint;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if p_base_version is null then
    insert into public.notes (owner_id, path, body, record, updated_by)
    values (uid, p_path, p_body, p_record, 'app')
    on conflict (owner_id, path) do nothing
    returning id, version into v_id, v_version;
  else
    update public.notes
       set body = p_body, record = p_record, updated_by = 'app',
           version = version + 1, updated_at = now()
     where owner_id = uid and path = p_path and version = p_base_version
    returning id, version into v_id, v_version;
  end if;

  if v_id is null then
    return null;
  end if;

  update public.note_revisions
     set body = p_body, version = v_version, updated_at = now()
   where id = (select id from public.note_revisions where note_id = v_id order by id desc limit 1)
     and author = 'app'
     and created_at > now() - interval '10 minutes';
  if not found then
    insert into public.note_revisions (note_id, owner_id, version, body, author)
    values (v_id, uid, v_version, p_body, 'app');
  end if;

  return v_version;
end;
$$;

-- ---- Reading, moving, folders ---------------------------------------------------------

-- The whole vault listing in one value (not subject to the API's row
-- limit): {notes: [{path, version}], folders: [path]}.
create or replace function public.list_vault()
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select json_build_object(
    'notes', coalesce((select json_agg(json_build_object('path', n.path, 'version', n.version) order by n.path)
                         from public.notes n where n.owner_id = (select auth.uid())), '[]'::json),
    'folders', coalesce((select json_agg(f.path order by f.path)
                           from public.folders f where f.owner_id = (select auth.uid())), '[]'::json)
  );
$$;

create or replace function public.move_note(p_from text, p_to text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.notes set path = p_to where owner_id = (select auth.uid()) and path = p_from;
  if not found then
    raise exception 'note not found' using errcode = 'P0002';
  end if;
end;
$$;

-- "a/b" is under "a" when it starts with "a/" — compared with left()
-- rather than LIKE, so names containing % or _ aren't wildcards.
create or replace function public.move_folder(p_from text, p_to text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  moved int := 0;
  n int;
begin
  if exists (
    select 1 from public.notes where owner_id = uid and left(path, length(p_to) + 1) = p_to || '/'
    union all
    select 1 from public.folders where owner_id = uid and (path = p_to or left(path, length(p_to) + 1) = p_to || '/')
  ) then
    raise exception 'destination exists' using errcode = '23505';
  end if;
  update public.notes set path = p_to || substr(path, length(p_from) + 1)
   where owner_id = uid and left(path, length(p_from) + 1) = p_from || '/';
  get diagnostics n = row_count;
  moved := moved + n;
  update public.folders set path = p_to || substr(path, length(p_from) + 1)
   where owner_id = uid and (path = p_from or left(path, length(p_from) + 1) = p_from || '/');
  get diagnostics n = row_count;
  moved := moved + n;
  if moved = 0 then
    raise exception 'folder not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.delete_folder(p_path text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.notes
   where owner_id = (select auth.uid()) and left(path, length(p_path) + 1) = p_path || '/';
  delete from public.folders
   where owner_id = (select auth.uid()) and (path = p_path or left(path, length(p_path) + 1) = p_path || '/');
$$;

-- ---- Search, backlinks, history -----------------------------------------------------

-- Search as you type: every word must match, the last one as a prefix;
-- titles also match as plain substrings.
create or replace function public.search_notes(p_query text, p_limit integer default 40)
returns table (path text, title text, excerpt text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  q tsquery;
  needle text := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  select to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' & '))
    into q
    from (select w from regexp_split_to_table(lower(p_query), '[[:space:][:punct:]]+') as w
           where w <> '' limit 12) words;
  if q is null then
    return;
  end if;
  return query
    select n.path, n.title,
           ts_headline('simple', left(n.body, 20000), q,
                       'StartSel="", StopSel="", MaxWords=24, MinWords=8, MaxFragments=1')
      from public.notes n
     where n.owner_id = (select auth.uid())
       and (n.search @@ q or n.title ilike needle)
     order by ts_rank(n.search, q) + case when n.title ilike needle then 1 else 0 end desc, n.title
     limit least(greatest(p_limit, 1), 200);
end;
$$;

-- Notes that [[link]] to p_path, as [[Folder/Note]] or just [[Note]].
create or replace function public.note_backlinks(p_path text)
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select n.path
    from public.notes n
   where n.owner_id = (select auth.uid())
     and n.links && array[
           lower(regexp_replace(p_path, '\.md$', '', 'i')),
           lower(regexp_replace(regexp_replace(p_path, '^.*/', ''), '\.md$', '', 'i'))
         ]
     and n.path <> p_path
   order by n.title;
$$;

create or replace function public.note_history(p_path text)
returns table (version bigint, author text, created_at timestamptz, updated_at timestamptz, length integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.version, r.author, r.created_at, r.updated_at, length(r.body)
    from public.note_revisions r
    join public.notes n on n.id = r.note_id
   where n.owner_id = (select auth.uid()) and n.path = p_path
   order by r.id desc
   limit 200;
$$;

revoke all on function
  public.save_note(text, text, text, bigint),
  public.list_vault(),
  public.move_note(text, text),
  public.move_folder(text, text),
  public.delete_folder(text),
  public.search_notes(text, integer),
  public.note_backlinks(text),
  public.note_history(text)
from public, anon;

grant execute on function
  public.save_note(text, text, text, bigint),
  public.list_vault(),
  public.move_note(text, text),
  public.move_folder(text, text),
  public.delete_folder(text),
  public.search_notes(text, integer),
  public.note_backlinks(text),
  public.note_history(text)
to authenticated;
