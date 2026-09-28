-- Personal vault device leases (Free single-device rule, take-over, publish markers).
-- Holds no vault content. Clients write only through the RPCs in the next migration.
-- See docs/MULTI_DEVICE_SYNC.md section 9.4.

create table if not exists public.personal_vault_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  vault_key uuid not null,                        -- sync_state.lineage_id
  device_id uuid not null,                        -- device_uuid (per install)
  lease_id uuid not null,                         -- new on every acquire; heartbeat and release must match
  session_nonce uuid not null,                    -- per app launch
  device_name text not null check (char_length(device_name) between 1 and 120),
  platform text not null check (platform in ('macos','windows','linux','ios','ipados')),
  app_version text check (char_length(app_version) <= 40),
  file_name text check (char_length(file_name) <= 255),
  file_id uuid,
  location text check (char_length(location) <= 120),
  status text not null default 'active' check (status in ('active','released','expired','displaced')),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_active_at timestamptz not null default now(),
  busy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(busy) = 'object' and pg_column_size(busy) <= 256),
  flags jsonb not null default '{}'::jsonb
    check (jsonb_typeof(flags) = 'object' and pg_column_size(flags) <= 256),
  displaced_by_device uuid,
  displaced_reason text check (displaced_reason in ('takeover','plan_limit')),
  displaced_at timestamptz,
  written_vv jsonb not null default '{}'::jsonb   -- one publish marker: {"<dev>": [ms, c]}
    check (jsonb_typeof(written_vv) = 'object' and pg_column_size(written_vv) <= 1024),
  written_at timestamptz,
  pending_changes boolean not null default false,
  abandoned_at timestamptz,
  primary key (user_id, vault_key, device_id)
);
create index if not exists personal_vault_sessions_active_idx
  on public.personal_vault_sessions (user_id, vault_key) where status = 'active';

alter table public.personal_vault_sessions enable row level security;
drop policy if exists "vault sessions: read own" on public.personal_vault_sessions;
create policy "vault sessions: read own" on public.personal_vault_sessions
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.personal_vault_sessions from anon, authenticated;
grant select on public.personal_vault_sessions to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'personal_vault_sessions') then
    alter publication supabase_realtime add table public.personal_vault_sessions;
  end if;
end $$;

create or replace function public.vault_device_limit(p_uid uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.is_team_member then -1
    else coalesce((t.features->>'vault_max_open_devices')::int,
                  case when t.name in ('pro','team') then -1 else 1 end) end
  from public.user_profiles p left join public.tiers t on t.id = p.tier_id
  where p.id = p_uid
$$;

create or replace function public.vault_session_is_busy(p_busy jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(case when jsonb_typeof(p_busy->'sessions') = 'number'
                       then (p_busy->>'sessions')::numeric > 0 end, false)
      or coalesce(case when jsonb_typeof(p_busy->'jobs') = 'number'
                       then (p_busy->>'jobs')::numeric > 0 end, false)
$$;

create or replace function public.vault_session_holders(p_uid uuid, p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', device_id, 'device_name', device_name, 'platform', platform,
      'file_name', file_name, 'file_id', file_id, 'location', location,
      'last_active_at', last_active_at, 'busy', busy)
      order by last_active_at desc), '[]'::jsonb)
  from public.personal_vault_sessions
  where user_id = p_uid and vault_key = p_vault_key and status = 'active'
    and expires_at >= now() and device_id <> p_device_id
$$;

create or replace function public.vault_sessions_for(p_uid uuid, p_vault_key uuid, p_device_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'device_id', s.device_id, 'device_name', s.device_name, 'platform', s.platform,
      'file_name', s.file_name, 'file_id', s.file_id, 'location', s.location,
      'status', case when s.status = 'active' and s.expires_at < now() then 'expired' else s.status end,
      'last_active_at', s.last_active_at, 'busy', s.busy, 'flags', s.flags,
      'written_vv', s.written_vv, 'written_at', s.written_at,
      'pending_changes', s.pending_changes, 'abandoned', s.abandoned_at is not null)
      order by s.last_active_at desc), '[]'::jsonb)
  from public.personal_vault_sessions s
  where s.user_id = p_uid and s.vault_key = p_vault_key and s.device_id <> p_device_id
    and s.heartbeat_at > now() - interval '30 days'
$$;

revoke execute on function public.vault_device_limit(uuid) from public, anon, authenticated;
revoke execute on function public.vault_session_is_busy(jsonb) from public, anon, authenticated;
revoke execute on function public.vault_session_holders(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.vault_sessions_for(uuid, uuid, uuid) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then        -- [A] enabled in prod
    perform cron.schedule('purge-personal-vault-sessions', '17 3 * * *',
      -- By age alone: a lease that lapsed without a release stays 'active' (its 90 s TTL is long gone).
      $cron$delete from public.personal_vault_sessions
             where heartbeat_at < now() - interval '30 days'$cron$);
  end if;
end $$;
