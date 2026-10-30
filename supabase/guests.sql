-- startblank: writing without an account
--
-- Run this once in the Supabase SQL editor, after vault.sql.
--
-- Also turn on Authentication > Sign In / Providers > "Allow anonymous
-- sign-ins" (and ideally CAPTCHA, since anyone can create a guest user).
--
-- A guest is a Supabase anonymous user: it has the authenticated role, and
-- its token carries is_anonymous = true. Guests may write notes at the top
-- of their vault, but not make folders, put notes in folders, or publish.
-- These are restrictive policies, so they narrow the "Own ..." policies in
-- vault.sql and accounts.sql rather than replacing them.

create or replace function public.is_guest()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

drop policy if exists "Guests make no folders" on public.folders;
create policy "Guests make no folders" on public.folders
  as restrictive
  for insert to authenticated
  with check (not (select public.is_guest()));

drop policy if exists "Guests rename no folders" on public.folders;
create policy "Guests rename no folders" on public.folders
  as restrictive
  for update to authenticated
  using (not (select public.is_guest()));

-- Renames (move_note, move_folder) go through table access, so RLS
-- applies; save_note() is security definer and checks for itself below.
drop policy if exists "Guest notes stay at the top" on public.notes;
create policy "Guest notes stay at the top" on public.notes
  as restrictive
  for update to authenticated
  using (true)
  with check (not (select public.is_guest()) or strpos(path, '/') = 0);

drop policy if exists "Guests don't publish" on public.documents;
create policy "Guests don't publish" on public.documents
  as restrictive
  for insert to authenticated
  with check (not (select public.is_guest()));

-- save_note() from vault.sql, plus the guest check.
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
  if public.is_guest() and strpos(p_path, '/') > 0 then
    raise exception 'create an account to use folders' using errcode = '42501';
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
