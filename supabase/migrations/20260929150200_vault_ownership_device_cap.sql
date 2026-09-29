-- Personal vault ownership (one account per lineage, 14 days of grace per vault and per pair of
-- accounts, release), the per-account device cap, and the minimum app version in the lease RPCs.
-- See docs/PLAN_ENFORCEMENT.md sections 2.3 to 2.6.

-- Ownership --------------------------------------------------------------------------------------

create table if not exists public.personal_vault_owners (
  vault_key uuid primary key,                       -- sync_state.lineage_id (same key as personal_vault_sessions)
  owner_id uuid references auth.users(id) on delete set null,   -- null: unowned (released or account deleted)
  owner_since timestamptz,                          -- when owner_id got its value; drives the release cooldown
  first_seen_at timestamptz not null default now(),
  grace_started_at timestamptz,                     -- first lease granted to any other account; never reset
  released_at timestamptz,
  released_by uuid,                                 -- last account that released it (no FK: kept after deletion)
  updated_at timestamptz not null default now(),
  check (owner_id is null or owner_since is not null)
);
create index if not exists personal_vault_owners_owner_idx on public.personal_vault_owners (owner_id);

-- The FK's SET NULL runs as an UPDATE of owner_id only; this trigger finishes the "unowned" row so the
-- auth.users delete never fails.
create or replace function public.personal_vault_owners_normalize() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.owner_id is null and old.owner_id is not null then
    new.owner_since := null;
    new.released_at := coalesce(new.released_at, now());
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.personal_vault_owners_normalize() from public, anon, authenticated;
drop trigger if exists trg_personal_vault_owners_normalize on public.personal_vault_owners;
create trigger trg_personal_vault_owners_normalize before update on public.personal_vault_owners
  for each row execute function public.personal_vault_owners_normalize();

alter table public.personal_vault_owners enable row level security;
drop policy if exists "vault owners: read own" on public.personal_vault_owners;
create policy "vault owners: read own" on public.personal_vault_owners
  for select to authenticated using (owner_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.personal_vault_owners from anon, authenticated;
grant select on public.personal_vault_owners to authenticated;

-- Grace per pair of accounts (lo/hi = least/greatest of owner and guest, so swapping roles keeps the clock).
create table if not exists public.personal_vault_guest_grace (
  account_lo uuid not null references auth.users(id) on delete cascade,
  account_hi uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  primary key (account_lo, account_hi),
  check (account_lo < account_hi)
);
create index if not exists personal_vault_guest_grace_hi_idx on public.personal_vault_guest_grace (account_hi);
alter table public.personal_vault_guest_grace enable row level security;   -- no policies: server functions only
revoke all on public.personal_vault_guest_grace from anon, authenticated;

-- p_write = false is a pure read. p_write = true runs only right before an acquire is granted: it claims
-- an unowned vault when p_claim and starts the vault and pair grace clocks. The caller holds the
-- account lock and the lineage lock.
create or replace function public.vault_owner_resolve(p_uid uuid, p_vault_key uuid, p_write boolean, p_claim boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v public.personal_vault_owners;
  v_days int := public.app_config_int('vault_share_grace_days', 14);
  v_cool int := public.app_config_int('vault_release_cooldown_days', 7);
  v_lo uuid; v_hi uuid; v_pair timestamptz; v_until timestamptz; v_shared timestamptz;
begin
  if p_write and p_claim then
    insert into public.personal_vault_owners (vault_key, owner_id, owner_since)
    values (p_vault_key, p_uid, now()) on conflict (vault_key) do nothing;
  end if;
  select * into v from public.personal_vault_owners where vault_key = p_vault_key for update;
  if not found then return jsonb_build_object('ownership', 'unowned'); end if;

  if v.owner_id is null then
    if not (p_write and p_claim) then return jsonb_build_object('ownership', 'unowned'); end if;
    update public.personal_vault_owners
       set owner_id = p_uid, owner_since = now(), released_at = null, updated_at = now()
     where vault_key = p_vault_key;
    return jsonb_build_object('ownership', 'owner', 'release_after', now() + make_interval(days => v_cool),
                              'shared_until', null);
  end if;

  if v.owner_id = p_uid then
    v_shared := v.grace_started_at + make_interval(days => v_days);
    return jsonb_build_object('ownership', 'owner',
      'release_after', v.owner_since + make_interval(days => v_cool),
      'shared_until', case when v_shared > now() then v_shared end);
  end if;

  v_lo := least(v.owner_id, p_uid); v_hi := greatest(v.owner_id, p_uid);
  if p_write then
    insert into public.personal_vault_guest_grace (account_lo, account_hi) values (v_lo, v_hi)
      on conflict do nothing;
    if v.grace_started_at is null then
      update public.personal_vault_owners set grace_started_at = now(), updated_at = now()
       where vault_key = p_vault_key;
      v.grace_started_at := now();
    end if;
  end if;
  select started_at into v_pair from public.personal_vault_guest_grace
   where account_lo = v_lo and account_hi = v_hi;
  v_until := least(coalesce(v.grace_started_at, now()), coalesce(v_pair, now())) + make_interval(days => v_days);
  if now() < v_until then
    return jsonb_build_object('ownership', 'grace', 'grace_until', v_until);
  end if;
  return jsonb_build_object('ownership', 'not_owner', 'grace_ended_at', v_until,
                            'released', v.released_by is not distinct from p_uid);
end $$;
revoke execute on function public.vault_owner_resolve(uuid, uuid, boolean, boolean) from public, anon, authenticated;

create or replace function public.vault_owner_release(p_vault_key uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v public.personal_vault_owners;
  v_cool int := public.app_config_int('vault_release_cooldown_days', 7);
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null then raise exception 'missing id' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('vault-owner:' || p_vault_key::text, 0));
  select * into v from public.personal_vault_owners where vault_key = p_vault_key for update;
  if not found or v.owner_id is distinct from v_uid then
    return jsonb_build_object('released', false, 'reason', 'not_owner');
  end if;
  if v.owner_since > now() - make_interval(days => v_cool) then
    return jsonb_build_object('released', false, 'reason', 'too_soon',
      'retry_after', v.owner_since + make_interval(days => v_cool));
  end if;
  update public.personal_vault_owners
     set owner_id = null, owner_since = null, released_at = now(), released_by = v_uid, updated_at = now()
   where vault_key = p_vault_key;
  return jsonb_build_object('released', true);
end $$;
revoke execute on function public.vault_owner_release(uuid) from public, anon;
grant execute on function public.vault_owner_release(uuid) to authenticated;

-- Device cap -------------------------------------------------------------------------------------

update public.tiers set features = features || '{"account_max_active_devices": 5}'::jsonb, updated_at = now()
 where name in ('free', 'pro', 'team');

-- -1 means no cap. A missing key uses app_config account_max_active_devices_fallback (5).
create or replace function public.account_device_cap(p_uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when jsonb_typeof(t.features -> 'account_max_active_devices') = 'number'
                 then (t.features ->> 'account_max_active_devices')::int end
       from public.user_profiles p left join public.tiers t on t.id = p.tier_id where p.id = p_uid),
    public.app_config_int('account_max_active_devices_fallback', 5))
$$;

-- One entry per OTHER device with a live lease of this account, least valuable first
-- (idle before busy, then least recently active): element 0 is what a take-over displaces.
create or replace function public.vault_session_device_holders(p_uid uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with live as (
    select * from public.personal_vault_sessions
     where user_id = p_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id),
  latest as (
    select distinct on (device_id) device_id, device_name, platform, file_name, file_id, location
      from live order by device_id, last_active_at desc),
  agg as (
    select device_id, count(*) as vaults, max(last_active_at) as last_active_at,
           bool_or(public.vault_session_is_busy(busy)) as is_busy,
           sum(case when jsonb_typeof(busy -> 'sessions') = 'number' then greatest((busy ->> 'sessions')::numeric, 0) else 0 end) as sessions,
           sum(case when jsonb_typeof(busy -> 'jobs') = 'number' then greatest((busy ->> 'jobs')::numeric, 0) else 0 end) as jobs
      from live group by device_id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', l.device_id, 'device_name', l.device_name, 'platform', l.platform,
      'file_name', l.file_name, 'file_id', l.file_id, 'location', l.location,
      'last_active_at', a.last_active_at, 'busy', jsonb_build_object('sessions', a.sessions, 'jobs', a.jobs),
      'vaults', a.vaults)
      order by a.is_busy asc, a.last_active_at asc, l.device_id), '[]'::jsonb)
  from latest l join agg a using (device_id)
$$;

-- True when this device would be a NEW device over the cap (read only; used by peek and acquire).
create or replace function public.vault_session_over_cap(p_uid uuid, p_vault_key uuid, p_device_id uuid, p_cap int)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_cap <> -1
     and not exists (select 1 from public.personal_vault_sessions
                      where user_id = p_uid and device_id = p_device_id and vault_key <> p_vault_key
                        and status = 'active' and expires_at >= now())
     and (select count(distinct device_id) from public.personal_vault_sessions
           where user_id = p_uid and status = 'active' and expires_at >= now()
             and device_id <> p_device_id) >= p_cap
$$;

-- The device the account cap would ALSO lock when a take-over first displaces p_skip on this vault.
-- Null when the cap would not be exceeded. Read only; feeds also_locks.
create or replace function public.vault_session_cap_victim(
  p_uid uuid, p_vault_key uuid, p_device_id uuid, p_cap int, p_skip uuid[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with live as (
    select * from public.personal_vault_sessions
     where user_id = p_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id
       and not (vault_key = p_vault_key and device_id = any(coalesce(p_skip, '{}')))),
  dev as (
    select device_id, bool_or(public.vault_session_is_busy(busy)) as is_busy, max(last_active_at) as la
      from live group by device_id)
  select case
    when p_cap = -1 or (select count(*) from dev) < p_cap then null
    when exists (select 1 from public.personal_vault_sessions
                  where user_id = p_uid and device_id = p_device_id and vault_key <> p_vault_key
                    and status = 'active' and expires_at >= now()) then null
    else (select jsonb_build_object('device_id', d.device_id,
                   'device_name', (select l.device_name from live l where l.device_id = d.device_id
                                    order by l.last_active_at desc limit 1))
            from dev d order by d.is_busy asc, d.la asc, d.device_id limit 1) end
$$;

revoke execute on function public.account_device_cap(uuid), public.vault_session_device_holders(uuid, uuid),
  public.vault_session_over_cap(uuid, uuid, uuid, int),
  public.vault_session_cap_victim(uuid, uuid, uuid, int, uuid[]) from public, anon, authenticated;

alter table public.personal_vault_sessions drop constraint if exists personal_vault_sessions_displaced_reason_check;
alter table public.personal_vault_sessions add constraint personal_vault_sessions_displaced_reason_check
  check (displaced_reason in ('takeover', 'plan_limit', 'device_cap', 'not_owner', 'update_required'));
create index if not exists personal_vault_sessions_user_active_idx
  on public.personal_vault_sessions (user_id, device_id) where status = 'active';

-- Lease RPCs -------------------------------------------------------------------------------------

drop function if exists public.vault_session_peek(uuid, uuid);
create or replace function public.vault_session_peek(
  p_vault_key uuid, p_device_id uuid, p_platform text default null, p_app_version text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_cap int;
  v_out jsonb;
begin
  if v_uid is null then return null; end if;
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);
  v_cap := public.account_device_cap(v_uid);
  v_out := jsonb_build_object('limit', v_limit, 'device_cap', v_cap,
    'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id));
  if p_platform is not null and not public.app_version_ok(p_platform, p_app_version) then
    return v_out || jsonb_build_object('reason', 'update_required', 'min_version', public.app_min_version(p_platform));
  end if;
  if public.vault_session_over_cap(v_uid, p_vault_key, p_device_id, v_cap) then
    return v_out || jsonb_build_object('reason', 'device_cap',
      'devices', public.vault_session_device_holders(v_uid, p_device_id));
  end if;
  return v_out;
end $$;
revoke execute on function public.vault_session_peek(uuid, uuid, text, text) from public, anon;
grant execute on function public.vault_session_peek(uuid, uuid, text, text) to authenticated;

drop function if exists public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean);
create or replace function public.vault_session_acquire(
  p_vault_key uuid, p_device_id uuid, p_session_nonce uuid,
  p_device_name text, p_platform text, p_app_version text,
  p_file_name text, p_file_id uuid, p_location text, p_takeover boolean default false,
  p_claim boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_cap int;
  v_live int;
  v_devices int;
  v_own jsonb;
  v_victims uuid[];
  v_lease uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_vault_key is null or p_device_id is null or p_session_nonce is null then
    raise exception 'missing id' using errcode = '22023';
  end if;
  v_limit := coalesce(public.vault_device_limit(v_uid), 1);

  -- 1. Minimum version: before any lock or write. Unknown platforms fail once any minimum is set.
  if not public.app_version_ok(p_platform, p_app_version) then
    return jsonb_build_object('granted', false, 'reason', 'update_required', 'limit', v_limit,
      'min_version', public.app_min_version(p_platform),
      'holders', '[]'::jsonb, 'sessions', '[]'::jsonb, 'server_now', now());
  end if;

  -- 2. One lock per account: the device cap spans every vault.
  perform pg_advisory_xact_lock(hashtextextended('vault-acct:' || v_uid::text, 0));
  if (select count(*) from public.personal_vault_sessions
       where user_id = v_uid and heartbeat_at > now() - interval '1 day') > 200 then
    return jsonb_build_object('granted', false, 'error', 'too_many_sessions');
  end if;

  -- 3. Ownership, read only. The lineage lock keeps the answer valid until step 7.
  perform pg_advisory_xact_lock(hashtextextended('vault-owner:' || p_vault_key::text, 0));
  v_own := public.vault_owner_resolve(v_uid, p_vault_key, false, false);
  if v_own ->> 'ownership' = 'not_owner' then
    return jsonb_build_object('granted', false, 'reason', 'not_owner', 'limit', v_limit,
      'grace_ended_at', v_own -> 'grace_ended_at', 'released', coalesce((v_own ->> 'released')::boolean, false),
      'holders', '[]'::jsonb, 'sessions', '[]'::jsonb, 'server_now', now());
  end if;

  -- 4. Lapsed leases of the whole account.
  update public.personal_vault_sessions set status = 'expired'
   where user_id = v_uid and status = 'active' and expires_at < now();

  v_cap := public.account_device_cap(v_uid);

  -- 5. Per-vault plan limit.
  if v_limit <> -1 then
    select count(*) into v_live from public.personal_vault_sessions
     where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id;
    if v_live >= v_limit then
      select array_agg(device_id) into v_victims from (
        select device_id from public.personal_vault_sessions
         where user_id = v_uid and vault_key = p_vault_key and status = 'active' and device_id <> p_device_id
         order by public.vault_session_is_busy(busy) asc, last_active_at asc, device_id
         limit v_live - v_limit + 1) d;
      if not p_takeover then
        return jsonb_build_object('granted', false, 'reason', 'vault_limit', 'limit', v_limit, 'device_cap', v_cap,
          'also_locks', public.vault_session_cap_victim(v_uid, p_vault_key, p_device_id, v_cap, v_victims),
          'holders', public.vault_session_holders(v_uid, p_vault_key, p_device_id),
          'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
      end if;
      update public.personal_vault_sessions
         set status = 'displaced', displaced_by_device = p_device_id,
             displaced_reason = 'takeover', displaced_at = now()
       where user_id = v_uid and vault_key = p_vault_key and device_id = any(v_victims);
    end if;
  end if;

  -- 6. Account device cap (after step 5, so a device displaced there may no longer count).
  if public.vault_session_over_cap(v_uid, p_vault_key, p_device_id, v_cap) then
    if not p_takeover then
      return jsonb_build_object('granted', false, 'reason', 'device_cap', 'limit', v_limit, 'device_cap', v_cap,
        'holders', public.vault_session_device_holders(v_uid, p_device_id),
        'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
    end if;
    select count(distinct device_id) into v_devices from public.personal_vault_sessions
     where user_id = v_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id;
    select array_agg(device_id) into v_victims from (
      select device_id from public.personal_vault_sessions
       where user_id = v_uid and status = 'active' and expires_at >= now() and device_id <> p_device_id
       group by device_id
       order by bool_or(public.vault_session_is_busy(busy)) asc, max(last_active_at) asc, device_id
       limit v_devices - v_cap + 1) d;
    update public.personal_vault_sessions
       set status = 'displaced', displaced_by_device = p_device_id,
           displaced_reason = 'device_cap', displaced_at = now()
     where user_id = v_uid and status = 'active' and device_id = any(v_victims);
  end if;

  -- 7. The grant is certain now: commit ownership. It cannot turn into not_owner here: step 3's
  --    lineage lock is still held, and a first pair row starts at now().
  v_own := public.vault_owner_resolve(v_uid, p_vault_key, true, coalesce(p_claim, true));

  -- 8. Same device_id with another live nonce (a second running copy) is superseded here:
  --    its lease_id no longer matches, so its next heartbeat returns lost/superseded.
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

  -- 9. Grant.
  return jsonb_build_object('granted', true, 'lease_id', v_lease, 'limit', v_limit, 'device_cap', v_cap,
    'ownership', v_own ->> 'ownership', 'grace_until', v_own -> 'grace_until',
    'release_after', v_own -> 'release_after', 'shared_until', v_own -> 'shared_until',
    'ttl_seconds', 90, 'heartbeat_seconds', 30,
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;
revoke execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) from public, anon;
grant execute on function public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean, boolean) to authenticated;

-- The heartbeat's "displaced" answer. `by` is the displacing device's latest name across all of the
-- account's vaults (a device-cap displacer usually holds another vault); null for not_owner and
-- update_required.
create or replace function public.vault_session_displaced_answer(
  p_uid uuid, p_vault_key uuid, p_reason text, p_by_device uuid, p_platform text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_by text;
  v_own jsonb;
begin
  if p_reason = 'not_owner' then
    v_own := public.vault_owner_resolve(p_uid, p_vault_key, false, false);
    return jsonb_build_object('status', 'displaced', 'reason', p_reason, 'by', null,
      'grace_ended_at', v_own -> 'grace_ended_at', 'released', coalesce((v_own ->> 'released')::boolean, false));
  end if;
  if p_reason = 'update_required' then
    return jsonb_build_object('status', 'displaced', 'reason', p_reason, 'by', null,
      'min_version', public.app_min_version(p_platform));
  end if;
  select device_name into v_by from public.personal_vault_sessions
   where user_id = p_uid and device_id = p_by_device
   order by heartbeat_at desc limit 1;
  return jsonb_build_object('status', 'displaced', 'reason', p_reason, 'by', v_by);
end $$;
revoke execute on function public.vault_session_displaced_answer(uuid, uuid, text, uuid, text) from public, anon, authenticated;

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
  v_cap int;
  v_own jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('vault-acct:' || v_uid::text, 0));

  select * into v_row from public.personal_vault_sessions
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
  if not found then return jsonb_build_object('status', 'lost', 'reason', 'unknown'); end if;
  if v_row.lease_id is distinct from p_lease_id then
    return jsonb_build_object('status', 'lost', 'reason', 'superseded');
  end if;

  -- Record what this lease published, whatever its status.
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
    return public.vault_session_displaced_answer(v_uid, p_vault_key, v_row.displaced_reason,
      v_row.displaced_by_device, v_row.platform);
  end if;

  -- Never revive a released or lapsed lease: the client must acquire again.
  if v_row.status <> 'active' or v_row.expires_at < now() then
    update public.personal_vault_sessions set status = 'expired'
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id and status = 'active';
    return jsonb_build_object('status', 'lost',
      'reason', case when v_row.status = 'released' then 'released' else 'expired' end);
  end if;

  if not public.app_version_ok(v_row.platform, v_row.app_version) then
    update public.personal_vault_sessions set status = 'displaced', displaced_reason = 'update_required',
           displaced_at = now(), displaced_by_device = null
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
    return jsonb_build_object('status', 'displaced', 'reason', 'update_required', 'by', null,
      'min_version', public.app_min_version(v_row.platform));
  end if;
  v_own := public.vault_owner_resolve(v_uid, p_vault_key, false, false);   -- never claims, never starts a clock
  if v_own ->> 'ownership' = 'not_owner' then
    update public.personal_vault_sessions set status = 'displaced', displaced_reason = 'not_owner',
           displaced_at = now(), displaced_by_device = null
     where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
    return jsonb_build_object('status', 'displaced', 'reason', 'not_owner', 'by', null,
      'grace_ended_at', v_own -> 'grace_ended_at', 'released', coalesce((v_own ->> 'released')::boolean, false));
  end if;

  update public.personal_vault_sessions set heartbeat_at = now(),
         expires_at = now() + interval '90 seconds',
         last_active_at = case when p_active then now() else last_active_at end
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;

  v_limit := coalesce(public.vault_device_limit(v_uid), 1);
  if v_limit <> -1 then                     -- plan limit (downgrade): keep busy, then most recently active
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
  end if;

  v_cap := public.account_device_cap(v_uid);
  if v_cap <> -1 then                       -- account cap (cap lowered): keep busy devices, then most recent
    with dev as (
      select device_id, bool_or(public.vault_session_is_busy(busy)) as is_busy, max(last_active_at) as la
        from public.personal_vault_sessions
       where user_id = v_uid and status = 'active' and expires_at >= now() group by device_id),
    ranked as (select device_id, row_number() over (order by is_busy desc, la desc, device_id) as rn from dev),
    keeper as (select device_id from ranked where rn = 1)
    update public.personal_vault_sessions s
       set status = 'displaced', displaced_reason = 'device_cap', displaced_at = now(),
           displaced_by_device = (select device_id from keeper)
      from ranked r
     where s.user_id = v_uid and s.device_id = r.device_id and s.status = 'active' and r.rn > v_cap;
  end if;

  select * into v_row from public.personal_vault_sessions
   where user_id = v_uid and vault_key = p_vault_key and device_id = p_device_id;
  if v_row.status = 'displaced' then
    return public.vault_session_displaced_answer(v_uid, p_vault_key, v_row.displaced_reason,
      v_row.displaced_by_device, v_row.platform);
  end if;

  return jsonb_build_object('status', 'ok', 'limit', v_limit, 'device_cap', v_cap,
    'ownership', v_own ->> 'ownership', 'grace_until', v_own -> 'grace_until',
    'release_after', v_own -> 'release_after', 'shared_until', v_own -> 'shared_until',
    'sessions', public.vault_sessions_for(v_uid, p_vault_key, p_device_id), 'server_now', now());
end $$;
revoke execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) from public, anon;
grant execute on function public.vault_session_heartbeat(uuid,uuid,uuid,boolean,jsonb,jsonb,text,uuid,text,jsonb,boolean) to authenticated;
