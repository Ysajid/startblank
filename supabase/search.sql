-- startblank: server-side search, backlinks and the vault manifest
--
-- Run this once in the Supabase SQL editor, after vaults.sql. Then deploy
-- the indexer (see supabase/functions/index-note/index.ts):
--
--   supabase functions deploy index-note --no-verify-jwt
--
-- The files in the `vaults` bucket stay the only source of truth. The
-- table below is a derived, disposable search index: it holds the words of
-- each note as a tsvector (lexemes, not the text), its title, the targets
-- of its [[links]] and a short excerpt for search results — never the
-- note itself. It can be dropped and rebuilt from the files at any time
-- (the indexer's "reindex" op does that for one user).

create table if not exists public.note_index (
  owner_id uuid not null references auth.users (id) on delete cascade,
  path text not null,
  title text not null,
  excerpt text not null default '',
  -- lower-cased link targets without ".md" or "#heading", as written
  links text[] not null default '{}',
  search tsvector not null,
  indexed_at timestamptz not null default now(),
  primary key (owner_id, path)
);

create index if not exists note_index_search_idx on public.note_index using gin (search);
create index if not exists note_index_links_idx on public.note_index using gin (links);

alter table public.note_index enable row level security;

-- Explicit rather than relying on Supabase's default grants: users may only
-- read (and RLS narrows that to their own rows).
revoke all on public.note_index from anon, authenticated;
grant select on public.note_index to authenticated;
grant all on public.note_index to service_role;

-- Users can read their own index rows; only the indexer (service role)
-- writes them, through the functions below.
drop policy if exists "Users read their own index" on public.note_index;
create policy "Users read their own index"
  on public.note_index
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

-- ---- Written by the indexer only -------------------------------------------

create or replace function public.index_note(
  p_owner uuid,
  p_path text,
  p_title text,
  p_text text,
  p_excerpt text,
  p_links text[]
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.note_index (owner_id, path, title, excerpt, links, search, indexed_at)
  values (
    p_owner,
    p_path,
    p_title,
    p_excerpt,
    p_links,
    -- 'simple' (no stemming, no stop words) so every language is searchable.
    setweight(to_tsvector('simple', p_title), 'A') || setweight(to_tsvector('simple', p_text), 'B'),
    now()
  )
  on conflict (owner_id, path) do update
    set title = excluded.title,
        excerpt = excluded.excerpt,
        links = excluded.links,
        search = excluded.search,
        indexed_at = excluded.indexed_at;
$$;

create or replace function public.unindex_note(p_owner uuid, p_path text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.note_index where owner_id = p_owner and path = p_path;
$$;

revoke all on function public.index_note(uuid, text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.unindex_note(uuid, text) from public, anon, authenticated;
grant execute on function public.index_note(uuid, text, text, text, text, text[]) to service_role;
grant execute on function public.unindex_note(uuid, text) to service_role;

-- ---- Called by the app (as the signed-in user) ------------------------------

-- Every file in the caller's vault with its etag, in one query — replaces
-- walking the bucket folder by folder. Runs as the caller, so the storage
-- policies in vaults.sql still decide what they can see.
create or replace function public.list_vault_files()
returns table (name text, etag text)
language sql
stable
security invoker
set search_path = public
as $$
  select o.name, coalesce(o.metadata ->> 'eTag', '')
  from storage.objects o
  where o.bucket_id = 'vaults'
    and o.name like (select auth.uid())::text || '/%';
$$;

grant execute on function public.list_vault_files() to authenticated;

-- Search as you type: every word must match, the last one as a prefix-match
-- on any word. Titles also match as plain substrings, so a half-typed
-- title is found even mid-word.
create or replace function public.search_notes(p_query text, p_limit integer default 40)
returns table (path text, title text, excerpt text, rank real)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery;
  needle text := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  select to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' & '))
    into q
    from regexp_split_to_table(lower(p_query), '[[:space:][:punct:]]+') as w
   where w <> '';

  if q is null then
    return;
  end if;

  return query
    select n.path, n.title, n.excerpt, (ts_rank(n.search, q) + (case when n.title ilike needle then 1 else 0 end))::real
      from public.note_index n
     where n.owner_id = (select auth.uid())
       and (n.search @@ q or n.title ilike needle)
     order by 4 desc, n.title
     limit least(greatest(p_limit, 1), 200);
end;
$$;

grant execute on function public.search_notes(text, integer) to authenticated;

-- Notes linking to a note, given the lower-cased ways it can be linked to
-- (its path without ".md", and its title).
create or replace function public.note_backlinks(p_targets text[])
returns table (path text)
language sql
stable
security invoker
set search_path = public
as $$
  select n.path
    from public.note_index n
   where n.owner_id = (select auth.uid())
     and n.links && p_targets
   order by n.title;
$$;

grant execute on function public.note_backlinks(text[]) to authenticated;

-- ---- Optional: index writes from anywhere ------------------------------------
--
-- The app asks the indexer to reindex every note it saves. To also catch
-- files written by anything else (agents, scripts, the dashboard), add the
-- indexer's URL and a shared secret to Vault and install this trigger:
--
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/index-note', 'note_indexer_url');
--   select vault.create_secret('<long random string>', 'note_indexer_secret');
--   -- and set the same secret on the function:
--   --   supabase secrets set NOTE_INDEXER_SECRET=<long random string>
--
-- Some projects don't allow triggers on storage.objects; if so, this block
-- just reports it and everything else keeps working.

create extension if not exists pg_net;

create or replace function public.notify_note_indexer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  indexer_url text;
  indexer_secret text;
  hdrs jsonb;
begin
  select decrypted_secret into indexer_url from vault.decrypted_secrets where name = 'note_indexer_url';
  select decrypted_secret into indexer_secret from vault.decrypted_secrets where name = 'note_indexer_secret';
  if indexer_url is null or indexer_secret is null then
    return null;
  end if;
  hdrs := jsonb_build_object('Content-Type', 'application/json', 'x-indexer-secret', indexer_secret);

  -- Files under dot-folders (.startblank records, .keep markers) aren't notes.
  if tg_op <> 'INSERT' and old.bucket_id = 'vaults' and position('/.' in old.name) = 0
     and (tg_op = 'DELETE' or old.name is distinct from new.name) then
    perform net.http_post(indexer_url, jsonb_build_object('op', 'delete', 'keys', jsonb_build_array(old.name)), headers := hdrs);
  end if;
  if tg_op <> 'DELETE' and new.bucket_id = 'vaults' and position('/.' in new.name) = 0 then
    perform net.http_post(indexer_url, jsonb_build_object('op', 'upsert', 'keys', jsonb_build_array(new.name)), headers := hdrs);
  end if;
  return null;
end;
$$;

do $$
begin
  drop trigger if exists note_indexer on storage.objects;
  create trigger note_indexer
    after insert or update or delete on storage.objects
    for each row execute function public.notify_note_indexer();
exception when insufficient_privilege then
  raise notice 'Could not add the note_indexer trigger on storage.objects (%). The app still indexes its own saves.', sqlerrm;
end;
$$;
