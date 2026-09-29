-- Rollback of 20260929150000_team_membership_hardening: restores the live definitions read from
-- production on 2026-09-29. It reopens the holes that migration closed, so use it only to unblock a
-- broken website flow, and fix forward. Not rolled back: the guarded upsert_vault_entry_versioned
-- (the unguarded body is the worst hole) and the TRUNCATE/REFERENCES/TRIGGER revoke (no client uses them).

drop trigger if exists trg_enforce_team_seats on public.team_members;
drop function if exists public.enforce_team_seats();
drop trigger if exists trg_guard_team_member_update on public.team_members;
drop function if exists public.guard_team_member_update();
drop trigger if exists trg_guard_team_columns on public.teams;
drop function if exists public.guard_team_columns();
drop trigger if exists trg_cleanup_removed_team_member on public.team_members;
drop function if exists public.cleanup_removed_team_member();

drop policy if exists tm_update on public.team_members;
create policy tm_update on public.team_members for update using (is_team_admin(team_id, (select auth.uid())));
drop policy if exists tm_insert on public.team_members;
create policy tm_insert on public.team_members for insert with check (
  is_team_admin(team_id, (select auth.uid()))
  or not exists (select 1 from public.team_members existing where existing.team_id = team_members.team_id));
drop policy if exists ti_insert on public.team_invitations;
create policy ti_insert on public.team_invitations for insert with check (is_team_admin(team_id, (select auth.uid())));

-- guard_team_invitation_update as in 20260928003610.
create or replace function public.guard_team_invitation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;

  if new.team_id is distinct from old.team_id or new.id is distinct from old.id then
    raise exception 'an invitation cannot move to another team' using errcode = '42501';
  end if;

  if public.is_team_admin(old.team_id, (select auth.uid())) then
    return new;
  end if;

  if new.email is distinct from old.email
    or new.invited_by is distinct from old.invited_by
    or new.role is distinct from old.role
    or new.token is distinct from old.token
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at then
    raise exception 'only the invitation status can be changed' using errcode = '42501';
  end if;

  if old.status <> 'pending' or new.status not in ('accepted', 'declined') then
    raise exception 'only a pending invitation can be accepted or declined' using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_team_invitation_update() from public, anon, authenticated;

create or replace function public.is_team_vault_member(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members
                  where team_vault_id = p_vault_id and user_id = p_user_id)
$$;
create or replace function public.is_team_vault_admin(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members
                  where team_vault_id = p_vault_id and user_id = p_user_id and role = 'admin')
$$;
revoke execute on function public.is_team_vault_member(uuid, uuid), public.is_team_vault_admin(uuid, uuid) from public, anon;
grant execute on function public.is_team_vault_member(uuid, uuid), public.is_team_vault_admin(uuid, uuid) to authenticated;

drop policy if exists vault_key_wraps_insert on public.vault_key_wraps;
create policy vault_key_wraps_insert on public.vault_key_wraps for insert
  with check (is_team_vault_admin(team_vault_id, (select auth.uid())));

drop policy if exists team_vault_members_insert on public.team_vault_members;
create policy team_vault_members_insert on public.team_vault_members for insert with check (
  is_team_vault_admin(team_vault_id, (select auth.uid())) or not team_vault_has_members(team_vault_id));
drop policy if exists team_vault_members_update on public.team_vault_members;
create policy team_vault_members_update on public.team_vault_members for update
  using (is_team_vault_admin(team_vault_id, (select auth.uid())));
drop policy if exists team_vaults_insert on public.team_vaults;
create policy team_vaults_insert on public.team_vaults for insert with check (exists (
  select 1 from public.team_members tm
   where tm.team_id = team_vaults.team_id and tm.user_id = (select auth.uid()) and tm.role = 'admin'));

drop trigger if exists trg_guard_team_vault_member_update on public.team_vault_members;
drop function if exists public.guard_team_vault_member_update();

drop policy if exists vault_entries_insert on public.vault_entries;
create policy vault_entries_insert on public.vault_entries for insert with check (exists (
  select 1 from public.team_vault_members tvm join public.team_vaults tv on tv.id = tvm.team_vault_id
   where tv.id = vault_entries.vault_id and tvm.user_id = (select auth.uid()) and tvm.role in ('admin', 'editor')));
drop policy if exists vault_entries_update on public.vault_entries;
create policy vault_entries_update on public.vault_entries for update using (exists (
  select 1 from public.team_vault_members tvm join public.team_vaults tv on tv.id = tvm.team_vault_id
   where tv.id = vault_entries.vault_id and tvm.user_id = (select auth.uid()) and tvm.role in ('admin', 'editor')));
drop function if exists public.team_vault_folder_writable(uuid, uuid);

drop policy if exists vault_password_history_select on public.vault_password_history;
create policy vault_password_history_select on public.vault_password_history for select using (exists (
  select 1 from public.team_vault_members
   where team_vault_members.team_vault_id = vault_password_history.vault_id
     and team_vault_members.user_id = (select auth.uid())));
drop policy if exists vault_password_history_insert on public.vault_password_history;
create policy vault_password_history_insert on public.vault_password_history for insert with check (exists (
  select 1 from public.team_vault_members
   where team_vault_members.team_vault_id = vault_password_history.vault_id
     and team_vault_members.user_id = (select auth.uid()) and team_vault_members.role in ('editor', 'admin')));
drop policy if exists vault_password_history_update on public.vault_password_history;
create policy vault_password_history_update on public.vault_password_history for update using (exists (
  select 1 from public.team_vault_members
   where team_vault_members.team_vault_id = vault_password_history.vault_id
     and team_vault_members.user_id = (select auth.uid()) and team_vault_members.role in ('editor', 'admin')));
drop policy if exists vault_password_history_delete on public.vault_password_history;
create policy vault_password_history_delete on public.vault_password_history for delete using (exists (
  select 1 from public.team_vault_members
   where team_vault_members.team_vault_id = vault_password_history.vault_id
     and team_vault_members.user_id = (select auth.uid()) and team_vault_members.role = 'admin'));

drop policy if exists vfp_select on public.vault_folder_permissions;
create policy vfp_select on public.vault_folder_permissions for select to authenticated using (exists (
  select 1 from public.team_vault_members tvm
   where tvm.team_vault_id = vault_folder_permissions.vault_id and tvm.user_id = (select auth.uid())));
drop policy if exists vfp_insert on public.vault_folder_permissions;
create policy vfp_insert on public.vault_folder_permissions for insert to authenticated with check (exists (
  select 1 from public.team_vault_members tvm
   where tvm.team_vault_id = vault_folder_permissions.vault_id and tvm.user_id = (select auth.uid()) and tvm.role = 'admin'));
drop policy if exists vfp_update on public.vault_folder_permissions;
create policy vfp_update on public.vault_folder_permissions for update to authenticated using (exists (
  select 1 from public.team_vault_members tvm
   where tvm.team_vault_id = vault_folder_permissions.vault_id and tvm.user_id = (select auth.uid()) and tvm.role = 'admin'));
drop policy if exists vfp_delete on public.vault_folder_permissions;
create policy vfp_delete on public.vault_folder_permissions for delete to authenticated using (exists (
  select 1 from public.team_vault_members tvm
   where tvm.team_vault_id = vault_folder_permissions.vault_id and tvm.user_id = (select auth.uid()) and tvm.role = 'admin'));
