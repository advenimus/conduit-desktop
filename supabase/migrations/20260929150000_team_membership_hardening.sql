-- Team hardening: only the service role adds members, seats are enforced in the database, a removed
-- member loses every team-vault right, and the team-sync write RPC checks the caller.
-- See docs/PLAN_ENFORCEMENT.md section 2.7.

-- 1. Only the service role adds team members (website webhook, add-self and invite accept routes).
drop policy if exists tm_insert on public.team_members;

-- 2. Admins may change roles in their team; rows never move (the is_team_member sync trigger does not run on UPDATE).
drop policy if exists tm_update on public.team_members;
create policy tm_update on public.team_members for update to authenticated
  using (public.is_team_admin(team_id, (select auth.uid())))
  with check (public.is_team_admin(team_id, (select auth.uid())));

create or replace function public.guard_team_member_update() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id
     or new.user_id is distinct from old.user_id then
    raise exception 'a team member row cannot move' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_team_member_update on public.team_members;
create trigger trg_guard_team_member_update before update on public.team_members
  for each row execute function public.guard_team_member_update();

-- 3. Seats: no insert may exceed teams.max_seats, whatever the role (service role included), and a team
--    without a live subscription (dissolved) takes no members at all.
create or replace function public.enforce_team_seats() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_max int; v_count int; v_sub text;
begin
  select max_seats, stripe_subscription_id into v_max, v_sub
    from public.teams where id = new.team_id for update;
  if not found then raise exception 'team not found' using errcode = '23503'; end if;
  if v_sub is null then
    raise exception 'team_inactive: this team has no active plan' using errcode = '23514';
  end if;
  select count(*) into v_count from public.team_members where team_id = new.team_id;
  if v_count >= v_max then
    raise exception 'team_full: all % seats are in use', v_max using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.enforce_team_seats() from public, anon, authenticated;
drop trigger if exists trg_enforce_team_seats on public.team_members;
create trigger trg_enforce_team_seats before insert on public.team_members
  for each row execute function public.enforce_team_seats();

-- 4. teams: a signed-in owner may rename the team, nothing else (max_seats, owner_id and Stripe ids are server-only).
create or replace function public.guard_team_columns() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.id is distinct from old.id or new.slug is distinct from old.slug
    or new.owner_id is distinct from old.owner_id or new.max_seats is distinct from old.max_seats
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.created_at is distinct from old.created_at) then
    raise exception 'protected column' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_team_columns on public.teams;
create trigger trg_guard_team_columns before update on public.teams
  for each row execute function public.guard_team_columns();

-- 5. Team vault members: the added user must be on the vault's team; the empty-vault branch is only the creator bootstrap.
drop policy if exists team_vault_members_insert on public.team_vault_members;
create policy team_vault_members_insert on public.team_vault_members for insert to authenticated
with check (
  exists (select 1 from public.team_vaults tv
           where tv.id = team_vault_id and public.is_team_member(tv.team_id, team_vault_members.user_id))
  and (
    public.is_team_vault_admin(team_vault_id, (select auth.uid()))
    or (not public.team_vault_has_members(team_vault_id)
        and team_vault_members.user_id = (select auth.uid()) and role = 'admin'
        and exists (select 1 from public.team_vaults tv
                     where tv.id = team_vault_id and tv.created_by = (select auth.uid())
                       and public.is_team_admin(tv.team_id, (select auth.uid()))))));

drop policy if exists team_vault_members_update on public.team_vault_members;
create policy team_vault_members_update on public.team_vault_members for update to authenticated
  using (public.is_team_vault_admin(team_vault_id, (select auth.uid())))
  with check (public.is_team_vault_admin(team_vault_id, (select auth.uid())));

drop policy if exists team_vaults_insert on public.team_vaults;
create policy team_vaults_insert on public.team_vaults for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.team_members tm
     where tm.team_id = team_vaults.team_id and tm.user_id = (select auth.uid()) and tm.role = 'admin'));

-- 6. RLS does not apply to TRUNCATE; these roles never need it.
revoke truncate, references, trigger on public.teams, public.team_members, public.team_vaults,
  public.team_vault_members, public.team_invitations, public.tiers, public.user_profiles from anon, authenticated;

-- 7. Invitations: only the website invite route (service role, which reserves a seat) creates them.
--    Admins may still revoke, but may not extend expires_at or reopen an answered invitation.
drop policy if exists ti_insert on public.team_invitations;

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
    if new.expires_at > old.expires_at or new.token is distinct from old.token
       or (old.status <> 'pending' and new.status = 'pending') then
      raise exception 'an invitation cannot be extended or reopened' using errcode = '42501';
    end if;
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

drop trigger if exists guard_team_invitation_update on public.team_invitations;
create trigger guard_team_invitation_update
  before update on public.team_invitations
  for each row execute function public.guard_team_invitation_update();

-- 8. Removing a member (website remove route, team dissolution) also removes every team-vault right of
--    that person in that team, and flags those vaults for key rotation. team_vault_members has no FK to
--    team_members, so without this a removed member keeps reading entries, password history and key wraps.
create or replace function public.cleanup_removed_team_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.vault_folder_permissions p using public.team_vaults tv
   where tv.team_id = old.team_id and p.vault_id = tv.id and p.user_id = old.user_id;
  delete from public.vault_key_wraps w using public.team_vaults tv
   where tv.team_id = old.team_id and w.team_vault_id = tv.id and w.user_id = old.user_id;
  with gone as (
    delete from public.team_vault_members m using public.team_vaults tv
     where tv.team_id = old.team_id and m.team_vault_id = tv.id and m.user_id = old.user_id
    returning m.team_vault_id)
  update public.team_vaults set rotation_pending = true, updated_at = now()
   where id in (select team_vault_id from gone);
  return old;
end $$;
revoke execute on function public.cleanup_removed_team_member() from public, anon, authenticated;
drop trigger if exists trg_cleanup_removed_team_member on public.team_members;
create trigger trg_cleanup_removed_team_member after delete on public.team_members
  for each row execute function public.cleanup_removed_team_member();

-- Rows written before this migration: the vault helpers also require team membership.
create or replace function public.is_team_vault_member(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members m join public.team_vaults tv on tv.id = m.team_vault_id
                  where m.team_vault_id = p_vault_id and m.user_id = p_user_id
                    and public.is_team_member(tv.team_id, p_user_id))
$$;
create or replace function public.is_team_vault_admin(p_vault_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.team_vault_members m join public.team_vaults tv on tv.id = m.team_vault_id
                  where m.team_vault_id = p_vault_id and m.user_id = p_user_id and m.role = 'admin'
                    and public.is_team_member(tv.team_id, p_user_id))
$$;
revoke execute on function public.is_team_vault_member(uuid, uuid), public.is_team_vault_admin(uuid, uuid) from public, anon;
grant execute on function public.is_team_vault_member(uuid, uuid), public.is_team_vault_admin(uuid, uuid) to authenticated;

-- A key wrap may only be written for someone on the vault's team. Not is_team_vault_member: the desktop
-- inserts the wrap before the membership row (addMember and the admin auto-enroll).
drop policy if exists vault_key_wraps_insert on public.vault_key_wraps;
create policy vault_key_wraps_insert on public.vault_key_wraps for insert to authenticated
  with check (public.is_team_vault_admin(team_vault_id, (select auth.uid()))
              and exists (select 1 from public.team_vaults tv
                           where tv.id = team_vault_id and public.is_team_member(tv.team_id, vault_key_wraps.user_id)));

-- 9. The team-sync write RPC checks the caller. Same 23-argument signature the desktop calls;
--    p_updated_by is ignored and auth.uid() is stored. Grants back what 20260929141921 revoked.
--    The older 21- and 22-argument overloads (no guard, executable by anon) are gone in production but
--    still exist in databases restored from older backups, such as the local /verify stack.
drop function if exists public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text);
drop function if exists public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text);
create or replace function public.upsert_vault_entry_versioned(
  p_id uuid, p_vault_id uuid, p_name text, p_entry_type text, p_folder_id uuid default null,
  p_sort_order integer default 0, p_host text default null, p_port integer default null,
  p_username text default null, p_domain text default null, p_icon text default null,
  p_color text default null, p_notes text default null, p_password_encrypted text default null,
  p_private_key_encrypted text default null, p_config_encrypted text default null,
  p_tags_encrypted text default null, p_is_favorite boolean default false,
  p_expected_version integer default 0, p_updated_by uuid default null,
  p_credential_type text default null, p_totp_secret_encrypted text default null,
  p_parent_entry_id uuid default null)
returns table(success boolean, current_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_current_version integer;
  v_old_folder uuid;
  v_exists boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_vault_members tvm join public.team_vaults tv on tv.id = tvm.team_vault_id
                  where tvm.team_vault_id = p_vault_id and tvm.user_id = v_uid
                    and tvm.role in ('admin', 'editor') and public.is_team_member(tv.team_id, v_uid)) then
    raise exception 'not allowed to edit this vault' using errcode = '42501';
  end if;
  select version, folder_id into v_current_version, v_old_folder
    from public.vault_entries where id = p_id and vault_id = p_vault_id;
  v_exists := found;
  -- Folder restrictions apply to the target folder and, for an update, to the folder it leaves.
  if (p_folder_id is not null and coalesce(public.user_can_access_folder(p_vault_id, p_folder_id, v_uid), 'viewer') not in ('admin', 'editor'))
     or (v_exists and v_old_folder is not null and v_old_folder is distinct from p_folder_id
         and coalesce(public.user_can_access_folder(p_vault_id, v_old_folder, v_uid), 'viewer') not in ('admin', 'editor')) then
    raise exception 'not allowed to edit this folder' using errcode = '42501';
  end if;

  if not v_exists then
    insert into public.vault_entries (
      id, vault_id, name, entry_type, folder_id, parent_entry_id, sort_order,
      host, port, username, domain, icon, color, notes,
      password_encrypted, private_key_encrypted,
      config_encrypted, tags_encrypted, is_favorite,
      version, updated_by, credential_type, totp_secret_encrypted,
      created_at, updated_at
    ) values (
      p_id, p_vault_id, p_name, p_entry_type, p_folder_id, p_parent_entry_id, p_sort_order,
      p_host, p_port, p_username, p_domain, p_icon, p_color, p_notes,
      p_password_encrypted, p_private_key_encrypted,
      p_config_encrypted, p_tags_encrypted, p_is_favorite,
      1, v_uid, p_credential_type, p_totp_secret_encrypted,
      now(), now()
    );
    return query select true, 1;
  else
    update public.vault_entries set
      name = p_name,
      entry_type = p_entry_type,
      folder_id = p_folder_id,
      parent_entry_id = p_parent_entry_id,
      sort_order = p_sort_order,
      host = p_host,
      port = p_port,
      username = p_username,
      domain = p_domain,
      icon = p_icon,
      color = p_color,
      notes = p_notes,
      password_encrypted = p_password_encrypted,
      private_key_encrypted = p_private_key_encrypted,
      config_encrypted = p_config_encrypted,
      tags_encrypted = p_tags_encrypted,
      is_favorite = p_is_favorite,
      version = v_current_version + 1,
      updated_by = v_uid,
      credential_type = p_credential_type,
      totp_secret_encrypted = p_totp_secret_encrypted,
      updated_at = now()
    where id = p_id and vault_id = p_vault_id;
    return query select true, v_current_version + 1;
  end if;
end $$;
revoke execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) from public, anon;
grant execute on function public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid) to authenticated;
