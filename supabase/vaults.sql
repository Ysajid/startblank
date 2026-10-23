-- startblank: account vaults (notes as files)
--
-- Run this once in the Supabase SQL editor, after schema.sql.
--
-- Notes are not database rows. Each one is a Markdown file in the private
-- `vaults` Storage bucket, under a folder named after its owner's user id:
--
--   vaults/<auth.uid()>/Ideas/On walking.md
--
-- The policies below are the whole access model: a signed-in user can
-- read, create, overwrite, move and delete objects only inside their own
-- top-level folder. Nobody (signed in or not) can list or read anyone
-- else's. The bucket is private, so there are no public URLs either.
--
-- Also make sure Authentication > Providers > Email is enabled (it is by
-- default) and that the app's URL is in Authentication > URL Configuration
-- so sign-up confirmation emails link back to it.

insert into storage.buckets (id, name, public, file_size_limit)
values ('vaults', 'vaults', false, 5242880)
on conflict (id) do nothing;

create policy "Users read their own vault"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'vaults'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users add to their own vault"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'vaults'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users update their own vault"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'vaults'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'vaults'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users delete from their own vault"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'vaults'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Publishing now happens from inside an account, so record who published
-- each snapshot and stop accepting anonymous publishes. Existing published
-- documents keep a null owner and stay readable by link as before.
alter table public.documents
  add column if not exists owner_id uuid references auth.users (id) on delete set null default auth.uid();

create index if not exists documents_owner_id_idx on public.documents (owner_id);

drop policy if exists "Anyone can publish a document" on public.documents;

create policy "Signed-in users publish as themselves"
  on public.documents
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));
