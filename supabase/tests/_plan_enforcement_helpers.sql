-- Session-scoped helpers for the plan enforcement SQL tests. Included with \ir by
-- plan_enforcement_team.sql and plan_enforcement.sql; each psql run creates them again.

create function pg_temp.u(p_name text) returns uuid language sql immutable as $$
  select md5('plan-enforcement-test:' || p_name)::uuid
$$;

create function pg_temp.mk_user(p_name text, p_tier text default 'free') returns uuid language plpgsql as $$
declare v uuid := pg_temp.u(p_name);
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', p_name || '@plan.test',
          '{}'::jsonb, '{}'::jsonb, now(), now());
  update public.user_profiles set tier_id = (select id from public.tiers where name = p_tier) where id = v;
  return v;
end $$;

create function pg_temp.act(p_name text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_name), 'role', 'authenticated',
    'email', p_name || '@plan.test')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create function pg_temp.back() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql as the current role. Returns null when it succeeds, else "<sqlstate> <message>".
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

create function pg_temp.expect_err(p_id text, p_sql text, p_code text, p_like text default null) returns void language plpgsql as $$
declare e text := pg_temp.err(p_sql);
begin
  assert e is not null, format('%s: expected %s, the statement succeeded: %s', p_id, p_code, p_sql);
  assert left(e, 5) = p_code, format('%s: expected %s, got %s', p_id, p_code, e);
  assert p_like is null or e like p_like, format('%s: expected an error like %s, got %s', p_id, p_like, e);
end $$;

create function pg_temp.expect_ok(p_id text, p_sql text) returns void language plpgsql as $$
declare e text := pg_temp.err(p_sql);
begin
  assert e is null, format('%s: expected success, got %s for %s', p_id, e, p_sql);
end $$;

create function pg_temp.affected(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

create function pg_temp.ok(p_id text) returns void language plpgsql as $$
begin raise notice 'ok %', p_id; end $$;

-- Lease helpers: user, vault and device are names; pg_temp.u turns them into ids.
create function pg_temp.acq(p_user text, p_vault text, p_device text, p_takeover boolean default false,
  p_claim boolean default true, p_platform text default 'macos', p_version text default '0.18.0')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.act(p_user);
  r := public.vault_session_acquire(pg_temp.u(p_vault), pg_temp.u(p_device), gen_random_uuid(),
    'dev-' || p_device, p_platform, p_version, 'v.conduit', null, null, p_takeover, p_claim);
  perform pg_temp.back();
  return r;
end $$;

create function pg_temp.hb(p_user text, p_vault text, p_device text, p_active boolean default true)
returns jsonb language plpgsql as $$
declare r jsonb; v_lease uuid;
begin
  select lease_id into v_lease from public.personal_vault_sessions
   where user_id = pg_temp.u(p_user) and vault_key = pg_temp.u(p_vault) and device_id = pg_temp.u(p_device);
  perform pg_temp.act(p_user);
  r := public.vault_session_heartbeat(pg_temp.u(p_vault), pg_temp.u(p_device), v_lease, p_active);
  perform pg_temp.back();
  return r;
end $$;

create function pg_temp.peek(p_user text, p_vault text, p_device text, p_platform text default null,
  p_version text default null) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.act(p_user);
  r := public.vault_session_peek(pg_temp.u(p_vault), pg_temp.u(p_device), p_platform, p_version);
  perform pg_temp.back();
  return r;
end $$;

create function pg_temp.release(p_user text, p_vault text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.act(p_user);
  r := public.vault_owner_release(pg_temp.u(p_vault));
  perform pg_temp.back();
  return r;
end $$;

-- A live lease row written directly (a device the test does not drive through acquire).
create function pg_temp.live(p_user text, p_vault text, p_device text, p_ago interval,
  p_busy jsonb default '{}'::jsonb) returns void language sql as $$
  insert into public.personal_vault_sessions (user_id, vault_key, device_id, lease_id, session_nonce,
      device_name, platform, app_version, status, acquired_at, heartbeat_at, expires_at, last_active_at, busy)
  values (pg_temp.u(p_user), pg_temp.u(p_vault), pg_temp.u(p_device), gen_random_uuid(), gen_random_uuid(),
      'dev-' || p_device, 'macos', '0.18.0', 'active', now() - p_ago, now(), now() + interval '90 seconds',
      now() - p_ago, p_busy)
$$;

create function pg_temp.sess(p_user text, p_vault text, p_device text) returns public.personal_vault_sessions
language sql as $$
  select * from public.personal_vault_sessions
   where user_id = pg_temp.u(p_user) and vault_key = pg_temp.u(p_vault) and device_id = pg_temp.u(p_device)
$$;

create function pg_temp.owner_row(p_vault text) returns public.personal_vault_owners language sql as $$
  select * from public.personal_vault_owners where vault_key = pg_temp.u(p_vault)
$$;

create function pg_temp.set_min(p_desktop text, p_ios text) returns void language sql as $$
  update public.app_config set value = jsonb_build_object('desktop', p_desktop, 'ios', p_ios)
   where key = 'min_app_version'
$$;

-- Team helpers (written as postgres, so only the triggers apply).
create function pg_temp.mk_team(p_name text, p_owner text, p_seats int default 5, p_sub text default 'sub_test')
returns uuid language sql as $$
  insert into public.teams (id, name, slug, owner_id, max_seats, stripe_subscription_id)
  values (pg_temp.u('team:' || p_name), p_name, 'plan-test-' || p_name, pg_temp.u(p_owner), p_seats, p_sub)
  returning id
$$;

create function pg_temp.add_member(p_team text, p_user text, p_role text default 'member') returns void language sql as $$
  insert into public.team_members (team_id, user_id, role) values (pg_temp.u('team:' || p_team), pg_temp.u(p_user), p_role)
$$;

create function pg_temp.mk_tvault(p_team text, p_name text, p_creator text) returns uuid language sql as $$
  insert into public.team_vaults (id, team_id, name, created_by)
  values (pg_temp.u('tv:' || p_name), pg_temp.u('team:' || p_team), p_name, pg_temp.u(p_creator))
  returning id
$$;

create function pg_temp.add_tv_member(p_vault text, p_user text, p_role text) returns void language sql as $$
  insert into public.team_vault_members (team_vault_id, user_id, role)
  values (pg_temp.u('tv:' || p_vault), pg_temp.u(p_user), p_role)
$$;

create function pg_temp.upsert_sql(p_entry text, p_vault text, p_folder text default null, p_updated_by text default null)
returns text language sql as $$
  select format('select * from public.upsert_vault_entry_versioned(p_id := %L, p_vault_id := %L, p_name := %L, '
    || 'p_entry_type := %L, p_folder_id := %L, p_updated_by := %L)',
    pg_temp.u('entry:' || p_entry), pg_temp.u('tv:' || p_vault), p_entry, 'ssh',
    case when p_folder is null then null else pg_temp.u('folder:' || p_folder) end,
    case when p_updated_by is null then null else pg_temp.u(p_updated_by) end)
$$;

create function pg_temp.obj(p_user text, p_path text) returns text language sql as $$
  select pg_temp.u(p_user)::text || '/' || p_path
$$;

create function pg_temp.put_sql(p_user text, p_path text) returns text language sql as $$
  select format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)',
    'vaults', pg_temp.obj(p_user, p_path), pg_temp.u(p_user))
$$;

-- Fixture object written as postgres (bypasses the policies).
create function pg_temp.seed_obj(p_user text, p_path text) returns void language plpgsql as $$
begin execute pg_temp.put_sql(p_user, p_path); end $$;
