-- startblank: published documents
--
-- Run this once in the Supabase SQL editor (Database > SQL Editor) for
-- your project. The app only holds the publishable/anon key, which can't
-- run DDL, so this has to be applied by hand (or via the Supabase CLI).
--
-- Design note: a document's slug is its only access control — anyone who
-- has the link can view it, and there is no way to list or browse all
-- published documents (matching the "view-only via link" model in
-- PROJECT_PLAN.md). That means the anon role must NOT get a blanket
-- `select` policy on the table (that would let anyone dump every document
-- ever published with an unfiltered query). Instead, reads only happen
-- through get_document_by_slug(), a SECURITY DEFINER function that looks
-- up a single row by its exact slug — there's no way to enumerate slugs
-- through it.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  content text not null check (char_length(content) > 0),
  theme text not null,
  font text not null,
  stats jsonb not null,
  final_length integer not null,
  score numeric not null,
  published_at timestamptz not null default now()
);

alter table public.documents enable row level security;

-- Anyone can publish a new document; nobody can read, edit, or delete an
-- existing one through direct table access (reads go through the function
-- below; there is no edit/delete path at all — documents are immutable).
create policy "Anyone can publish a document"
  on public.documents
  for insert
  to anon
  with check (true);

create or replace function public.get_document_by_slug(p_slug text)
returns setof public.documents
language sql
security definer
set search_path = public
stable
as $$
  select * from public.documents where slug = p_slug limit 1;
$$;

grant execute on function public.get_document_by_slug(text) to anon;

-- Total published count, for the "N published" line shown alongside the
-- wordmark. Same reasoning as above: this exposes an aggregate number only,
-- never a row, so it can't be used to enumerate or read any document.
create or replace function public.get_published_count()
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select count(*) from public.documents;
$$;

grant execute on function public.get_published_count() to anon;
