-- Rollback of 20260929161800_vault_ownership_device_cap. Never removes an RPC signature desktop 0.18
-- or iOS 1.1 calls: acquire keeps 11 arguments and peek keeps 4, with the bodies of
-- 20260926150905 (the extra arguments are ignored). Release answers as if nothing is owned.
-- The two ownership tables are kept (data for a fix-forward); nothing reads them after this.

drop function if exists public.vault_session_peek(uuid, uuid, text, text);
create or replace function public.vault_session_peek(
  p_vault_key uuid, p_device_id uuid, p_platform text default null, p_app_version text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'limit', coalesce(public.vault_device_limit(auth.uid()), 1),
    'holders', public.vault_session_holders(auth.uid(), p_vault_key, p_device_id))
  where auth.uid() is not null
$$;
revoke execute on function public.vault_session_peek(uuid, uuid, text, text) from public, anon;
grant execute on function public.vault_session_peek(uuid, uuid, text, text) to authenticated;

create or replace function public.vault_session_acquire(
  p_vault_key uuid, p_device_id uuid, p_session_nonce uuid,
  p_device_name text, p_platform text, p_app_version text,
  p_file_name text, p_file_id uuid, p_location text, p_takeover boolean default false,
  p_claim boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_live int;
  v_lease uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null or p_device_id is null or p_session_nonce is null then
    raise exception 'missing id' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_vault_key::text, 0));
  if (select count(*) from public.personal_vault_sessions
       where user_id = v_uid and heartbeat_at > now() - interval '1 day') > 200 then
    return jsonb_build_object('granted', false, 'error', 'too_many_sessions');
  end if;
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);

  update public.personal_vault_sessions set status = 'expired'
   where user_id = v_uid and vault_key = p_vault_key and status = 'active' and expires_at < now();

  if v_limit <> -1 then
    select count(*) into v_live from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id;
    if v_live >= v_limit then
      if not p_takeover then
        return jsonb_build_object('granted', false, 'limit', v_limit,
          'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id),
          'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
      end if;
      update public.personal_vault_sessions
         set status = 'displaced', displaced_by_device = p_device_id,
             displaced_reason = 'takeover', displaced_at = now()
       where user_id = v_uid and vault_key = p_vault_key and device_id in (
         select device_id from public.personal_vault_sessions
          where user_id = v_uid and vault_key = p_vault_key and status = 'active'
            and device_id <> p_device_id
          order by public.vault_session_is_busy(busy) asc, last_active_at asc, device_id
          limit v_live - v_limit + 1);
    end if;
  end if;

  insert into public.personal_vault_sessions as s (
      user_id, vault_key, device_id, lease_id, session_nonce, device_name, platform, app_version,
      file_name, file_id, location, status, acquired_at, heartbeat_at, expires_at, last_active_at)
  values (v_uid, p_vault_key, p_device_id, v_lease, p_session_nonce, left(p_device_name, 120),
      p_platform, left(p_app_version, 40), left(p_file_name, 255), p_file_id, left(p_location, 120),
      'active', now(), now(), now() + interval '90 seconds', now())
  on conflict (user_id, vault_key, device_id) do update set
      lease_id = excluded.lease_id, session_nonce = excluded.session_nonce,
      device_name = excluded.device_name, platform = excluded.platform,
      app_version = excluded.app_version, file_name = excluded.file_name,
      file_id = excluded.file_id, location = excluded.location,
      status = 'active', acquired_at = now(), heartbeat_at = now(),
      expires_at = excluded.expires_at, last_active_at = now(),
      busy = '{}'::jsonb, flags = '{}'::jsonb, abandoned_at = null,
      displaced_by_device = null, displaced_reason = null, displaced_at = null;

  return jsonb_build_object('granted', true, 'lease_id', v_lease, 'limit', v_limit,
    'ttl_seconds', 90, 'heartbeat_seconds', 30,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;
revoke execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) from public, anon;
grant execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) to authenticated;

create or replace function public.vault_session_heartbeat(
  p_vault_key uuid, p_device_id uuid, p_lease_id uuid, p_active boolean,
  p_busy jsonb default null, p_flags jsonb default null,
  p_file_name text default null, p_file_id uuid default null, p_location text default null,
  p_written_vv jsonb default null, p_pending boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_row public.personal_vault_sessions;
  v_limit int;
  v_by text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_vault_key::text, 0));

  select * into v_row from public.personal_vault_sessions
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
  if not found then return jsonb_build_object('status', 'lost', 'reason', 'unknown'); end if;
  if v_row.lease_id is distinct from p_lease_id then
    return jsonb_build_object('status', 'lost', 'reason', 'superseded');
  end if;

  update public.personal_vault_sessions set
      written_vv = coalesce(p_written_vv, written_vv),
      written_at = case when p_written_vv is null then written_at else now() end,
      abandoned_at = case when p_written_vv is null then abandoned_at else null end,
      pending_changes = coalesce(p_pending, pending_changes),
      file_name = coalesce(left(p_file_name, 255), file_name),
      file_id = coalesce(p_file_id, file_id),
      location = coalesce(left(p_location, 120), location),
      busy = coalesce(p_busy, busy),
      flags = coalesce(p_flags, flags)
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;

  if v_row.status = 'displaced' then
    select device_name into v_by from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and device_id = v_row.displaced_by_device;
    return jsonb_build_object('status', 'displaced', 'reason', v_row.displaced_reason, 'by', v_by);
  end if;

  if v_row.status <> 'active' or v_row.expires_at < now() then
    update public.personal_vault_sessions set status = 'expired'
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id and status = 'active';
    return jsonb_build_object('status', 'lost',
      'reason', case when v_row.status = 'released' then 'released' else 'expired' end);
  end if;

  update public.personal_vault_sessions set heartbeat_at = now(),
         expires_at = now() + interval '90 seconds',
         last_active_at = case when p_active then now() else last_active_at end
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;

  v_limit := coalesce(public.vault_device_limit(v_uid), 1);
  if v_limit <> -1 then
    with ranked as (
      select device_id,
             row_number() over (order by public.vault_session_is_busy(busy) desc,
                                         last_active_at desc, device_id) as rn
        from public.personal_vault_sessions
       where user_id = v_uid and vault_key = p_vault_key and status = 'active' and expires_at >= now()),
    keeper as (select device_id from ranked where rn = 1)
    update public.personal_vault_sessions s
       set status = 'displaced', displaced_reason = 'plan_limit', displaced_at = now(),
           displaced_by_device = (select device_id from keeper)
      from ranked r
     where s.user_id = v_uid and s.vault_key = p_vault_key and s.device_id = r.device_id and r.rn > v_limit;

    select * into v_row from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
    if v_row.status = 'displaced' then
      select device_name into v_by from public.personal_vault_sessions
       where user_id = v_uid and vault_key = p_vault_key and device_id = v_row.displaced_by_device;
      return jsonb_build_object('status', 'displaced', 'reason', 'plan_limit', 'by', v_by);
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'limit', v_limit,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;
revoke execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) from public, anon;
grant execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) to authenticated;

create or replace function public.vault_owner_release(p_vault_key uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('released', false, 'reason', 'not_owner')
$$;
revoke execute on function public.vault_owner_release(uuid) from public, anon;
grant execute on function public.vault_owner_release(uuid) to authenticated;

update public.personal_vault_sessions set displaced_reason = 'plan_limit'
 where displaced_reason in ('device_cap', 'not_owner', 'update_required');
alter table public.personal_vault_sessions drop constraint if exists personal_vault_sessions_displaced_reason_check;
alter table public.personal_vault_sessions add constraint personal_vault_sessions_displaced_reason_check
  check (displaced_reason in ('takeover', 'plan_limit'));
drop index if exists public.personal_vault_sessions_user_active_idx;
drop function if exists public.vault_session_displaced_answer(uuid, uuid, text, uuid, text);
drop function if exists public.vault_owner_resolve(uuid, uuid, boolean, boolean);
drop function if exists public.vault_session_cap_victim(uuid, uuid, uuid, int, uuid[]);
drop function if exists public.vault_session_over_cap(uuid, uuid, uuid, int);
drop function if exists public.vault_session_device_holders(uuid, uuid);
drop function if exists public.account_device_cap(uuid);
update public.tiers set features = features - 'account_max_active_devices', updated_at = now()
 where name in ('free', 'pro', 'team');
