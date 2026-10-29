-- startblank: accounts
--
-- Run this once in the Supabase SQL editor, after schema.sql.
--
-- Notes, folders and revisions are in vault.sql (run it next). This file
-- covers what Supabase provides besides the notes: sign-in and the
-- published-snapshot table.
--
-- Make sure Authentication > Providers > Email is enabled (it is by
-- default) and that the app's URL is in Authentication > URL Configuration
-- so sign-up confirmation emails link back to it.

-- Publishing happens from inside an account, so record who published each
-- snapshot and stop accepting anonymous publishes. Existing published
-- documents keep a null owner and stay readable by link as before.
alter table public.documents
  add column if not exists owner_id uuid references auth.users (id) on delete set null default auth.uid();

create index if not exists documents_owner_id_idx on public.documents (owner_id);

drop policy if exists "Anyone can publish a document" on public.documents;
drop policy if exists "Signed-in users publish as themselves" on public.documents;

create policy "Signed-in users publish as themselves"
  on public.documents
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));
