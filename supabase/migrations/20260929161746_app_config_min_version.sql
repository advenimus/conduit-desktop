-- Server-side app settings (grace length, release cooldown, device cap fallback) and the minimum
-- app version per platform. The seeds are permissive: 0.0.0 turns the version check off.
-- See docs/PLAN_ENFORCEMENT.md section 2.2.

create table if not exists public.app_config (
  key text primary key check (key ~ '^[a-z0-9_]{1,64}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;       -- no policies: server functions only
revoke all on public.app_config from anon, authenticated;

insert into public.app_config (key, value) values
  ('min_app_version', '{"desktop": "0.0.0", "ios": "0.0.0"}'),
  ('vault_share_grace_days', '14'),
  ('vault_release_cooldown_days', '7'),
  ('account_max_active_devices_fallback', '5')
on conflict (key) do nothing;

-- [major, minor, patch] from "1.2.3", "v0.18", "1.1.0 (107)"; null when there is no leading number.
create or replace function public.version_parts(p text) returns int[]
language sql immutable set search_path = public, pg_temp as $$
  select case when m is null then null
    else array[m[1]::int, coalesce(m[2], '0')::int, coalesce(m[3], '0')::int] end
  from (select regexp_match(coalesce(p, ''), '^\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?') as m) x
$$;

create or replace function public.app_platform_group(p_platform text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_platform in ('macos', 'windows', 'linux') then 'desktop'
              when p_platform in ('ios', 'ipados') then 'ios' end
$$;

create or replace function public.app_min_version(p_platform text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value ->> public.app_platform_group(p_platform)
                     from public.app_config where key = 'min_app_version'), '0.0.0')
$$;

-- True when any platform has a minimum above 0.0.0.
create or replace function public.app_any_min_set() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select bool_or(public.version_parts(e.value) > array[0, 0, 0])
                     from public.app_config c, jsonb_each_text(c.value) e
                    where c.key = 'min_app_version' and jsonb_typeof(c.value) = 'object'), false)
$$;

-- True when no minimum is set (0.0.0 or unparseable config); otherwise an unparseable app version fails.
-- An unknown or null platform passes only while no platform has a minimum (else it could dodge the lever).
create or replace function public.app_version_ok(p_platform text, p_version text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with m as (select public.version_parts(public.app_min_version(p_platform)) as min)
  select case when public.app_platform_group(p_platform) is null then not public.app_any_min_set()
              when m.min is null or m.min = array[0, 0, 0] then true
              when public.version_parts(p_version) is null then false
              else public.version_parts(p_version) >= m.min end
  from m
$$;

create or replace function public.app_config_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::int end
                     from public.app_config where key = p_key), p_default)
$$;

revoke execute on function public.version_parts(text), public.app_platform_group(text),
  public.app_min_version(text), public.app_any_min_set(), public.app_version_ok(text, text),
  public.app_config_int(text, int)
  from public, anon, authenticated;
