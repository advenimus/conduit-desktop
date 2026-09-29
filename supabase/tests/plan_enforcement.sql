-- SQL tests for docs/PLAN_ENFORCEMENT.md section 7.1 (team hardening, ownership, device cap, minimum
-- version, cloud backup). Run by scripts/verify/run-sql-tests.mjs (npm run test:sql) against the
-- local stack after supabase/migrations and supabase/pending. Every case runs in begin ... rollback
-- and prints "ok <id>"; the first failed assert stops the run (ON_ERROR_STOP).
-- The concurrent cases (T4, O9) and the PostgREST cases (H1, H2) live in the runner.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- Helpers (session-scoped) ------------------------------------------------------------------------

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

-- Team hardening (M1) -----------------------------------------------------------------------------

begin;
do $$ begin
  perform pg_temp.mk_user('t1_x');
  perform pg_temp.mk_user('t1_owner', 'team');
  perform pg_temp.mk_team('t1', 't1_owner');
  perform pg_temp.act('t1_x');
  perform pg_temp.expect_err('T1', format('insert into public.team_members (team_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('team:t1'), pg_temp.u('t1_x'), 'admin'), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('T1');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t2_a', 'team');
  perform pg_temp.mk_user('t2_b');
  perform pg_temp.mk_team('t2', 't2_a');
  perform pg_temp.add_member('t2', 't2_a', 'admin');
  perform pg_temp.act('t2_a');
  perform pg_temp.expect_err('T2', format('insert into public.team_members (team_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('team:t2'), pg_temp.u('t2_b'), 'member'), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('T2');
end $$;
rollback;

begin;
do $$ declare i int; begin
  perform pg_temp.mk_user('t3_owner', 'team');
  for i in 1..4 loop perform pg_temp.mk_user('t3_m' || i); end loop;
  perform pg_temp.mk_team('t3', 't3_owner', 3);
  perform pg_temp.act_service();
  for i in 1..3 loop
    perform pg_temp.expect_ok('T3', format('insert into public.team_members (team_id, user_id) values (%L, %L)',
      pg_temp.u('team:t3'), pg_temp.u('t3_m' || i)));
  end loop;
  perform pg_temp.expect_err('T3', format('insert into public.team_members (team_id, user_id) values (%L, %L)',
    pg_temp.u('team:t3'), pg_temp.u('t3_m4')), '23514', '%team_full%');
  perform pg_temp.back();
  assert (select count(*) from public.team_members where team_id = pg_temp.u('team:t3')) = 3, 'T3: 3 members';
  perform pg_temp.ok('T3');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t5_a', 'team');
  perform pg_temp.mk_user('t5_m', 'team');
  perform pg_temp.mk_user('t5_z');
  perform pg_temp.mk_team('t5', 't5_a');
  perform pg_temp.mk_team('t5b', 't5_a');
  perform pg_temp.add_member('t5', 't5_a', 'admin');
  perform pg_temp.add_member('t5', 't5_m');
  perform pg_temp.add_member('t5b', 't5_a', 'admin');
  perform pg_temp.act('t5_a');
  perform pg_temp.expect_err('T5', format('update public.team_members set team_id = %L where team_id = %L and user_id = %L',
    pg_temp.u('team:t5b'), pg_temp.u('team:t5'), pg_temp.u('t5_m')), '42501');
  perform pg_temp.expect_err('T5', format('update public.team_members set user_id = %L where team_id = %L and user_id = %L',
    pg_temp.u('t5_z'), pg_temp.u('team:t5'), pg_temp.u('t5_m')), '42501');
  assert pg_temp.affected(format('update public.team_members set role = %L where team_id = %L and user_id = %L',
    'admin', pg_temp.u('team:t5'), pg_temp.u('t5_m'))) = 1, 'T5: a role change still works';
  perform pg_temp.back();
  perform pg_temp.ok('T5');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t6_o', 'team');
  perform pg_temp.mk_team('t6', 't6_o');
  perform pg_temp.add_member('t6', 't6_o', 'admin');
  perform pg_temp.act('t6_o');
  perform pg_temp.expect_err('T6', format('update public.teams set max_seats = 50 where id = %L', pg_temp.u('team:t6')), '42501');
  perform pg_temp.expect_err('T6', format('update public.teams set stripe_subscription_id = %L where id = %L',
    'sub_other', pg_temp.u('team:t6')), '42501');
  assert pg_temp.affected(format('update public.teams set name = %L where id = %L', 'Renamed', pg_temp.u('team:t6'))) = 1,
    'T6: the owner can rename';
  perform pg_temp.back();
  assert (select max_seats from public.teams where id = pg_temp.u('team:t6')) = 5, 'T6: max_seats unchanged';
  perform pg_temp.ok('T6');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t7_a', 'team');
  perform pg_temp.mk_user('t7_n');
  perform pg_temp.mk_team('t7', 't7_a');
  perform pg_temp.add_member('t7', 't7_a', 'admin');
  perform pg_temp.mk_tvault('t7', 't7v', 't7_a');
  perform pg_temp.act('t7_n');
  perform pg_temp.expect_err('T7', format('insert into public.team_vault_members (team_vault_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('tv:t7v'), pg_temp.u('t7_n'), 'admin'), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('T7');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t8_a', 'team');
  perform pg_temp.mk_user('t8_b', 'team');
  perform pg_temp.mk_team('t8', 't8_a');
  perform pg_temp.add_member('t8', 't8_a', 'admin');
  perform pg_temp.add_member('t8', 't8_b', 'admin');
  perform pg_temp.act('t8_a');
  perform pg_temp.expect_ok('T8', format('insert into public.team_vaults (id, team_id, name, created_by) values (%L, %L, %L, %L)',
    pg_temp.u('tv:t8v'), pg_temp.u('team:t8'), 'V', pg_temp.u('t8_a')));
  perform pg_temp.expect_ok('T8', format('insert into public.team_vault_members (team_vault_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('tv:t8v'), pg_temp.u('t8_a'), 'admin'));
  perform pg_temp.expect_err('T8', format('insert into public.team_vaults (id, team_id, name, created_by) values (%L, %L, %L, %L)',
    pg_temp.u('tv:t8w'), pg_temp.u('team:t8'), 'W', pg_temp.u('t8_b')), '42501');
  perform pg_temp.back();
  -- The bootstrap branch is only for the creator: b (an admin, not the creator) cannot seed an empty vault.
  perform pg_temp.mk_tvault('t8', 't8x', 't8_a');
  perform pg_temp.act('t8_b');
  perform pg_temp.expect_err('T8', format('insert into public.team_vault_members (team_vault_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('tv:t8x'), pg_temp.u('t8_b'), 'admin'), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('T8');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t9_a', 'team');
  perform pg_temp.mk_user('t9_m', 'team');
  perform pg_temp.mk_user('t9_out');
  perform pg_temp.mk_team('t9', 't9_a');
  perform pg_temp.add_member('t9', 't9_a', 'admin');
  perform pg_temp.add_member('t9', 't9_m');
  perform pg_temp.mk_tvault('t9', 't9v', 't9_a');
  perform pg_temp.add_tv_member('t9v', 't9_a', 'admin');
  perform pg_temp.act('t9_a');
  perform pg_temp.expect_err('T9', format('insert into public.team_vault_members (team_vault_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('tv:t9v'), pg_temp.u('t9_out'), 'viewer'), '42501');
  perform pg_temp.expect_ok('T9', format('insert into public.team_vault_members (team_vault_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('tv:t9v'), pg_temp.u('t9_m'), 'viewer'));
  perform pg_temp.back();
  perform pg_temp.ok('T9');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t10_o', 'team');
  perform pg_temp.mk_team('t10', 't10_o', 5, null);
  perform pg_temp.act_service();
  perform pg_temp.expect_err('T10', format('insert into public.team_members (team_id, user_id, role) values (%L, %L, %L)',
    pg_temp.u('team:t10'), pg_temp.u('t10_o'), 'admin'), '23514', '%team_inactive%');
  perform pg_temp.back();
  perform pg_temp.ok('T10');
end $$;
rollback;

begin;
do $$ declare r record; begin
  perform pg_temp.mk_user('t11_a', 'team');
  perform pg_temp.mk_user('t11_e', 'team');
  perform pg_temp.mk_user('t11_v', 'team');
  perform pg_temp.mk_user('t11_r', 'team');
  perform pg_temp.mk_user('t11_out');
  perform pg_temp.mk_team('t11', 't11_a');
  perform pg_temp.add_member('t11', 't11_a', 'admin');
  perform pg_temp.add_member('t11', 't11_e');
  perform pg_temp.add_member('t11', 't11_v');
  perform pg_temp.add_member('t11', 't11_r');
  perform pg_temp.mk_tvault('t11', 't11v', 't11_a');
  perform pg_temp.add_tv_member('t11v', 't11_a', 'admin');
  perform pg_temp.add_tv_member('t11v', 't11_e', 'editor');
  perform pg_temp.add_tv_member('t11v', 't11_v', 'viewer');
  perform pg_temp.add_tv_member('t11v', 't11_r', 'editor');
  delete from public.team_members where team_id = pg_temp.u('team:t11') and user_id = pg_temp.u('t11_r');

  perform pg_temp.act('t11_v');
  perform pg_temp.expect_err('T11 viewer', pg_temp.upsert_sql('e1', 't11v'), '42501');
  perform pg_temp.act('t11_r');
  perform pg_temp.expect_err('T11 removed', pg_temp.upsert_sql('e1', 't11v'), '42501');
  perform pg_temp.act('t11_out');
  perform pg_temp.expect_err('T11 outsider', pg_temp.upsert_sql('e1', 't11v'), '42501');
  perform pg_temp.act('t11_e');
  perform pg_temp.expect_ok('T11 editor', pg_temp.upsert_sql('e1', 't11v', null, 't11_a'));
  perform pg_temp.expect_ok('T11 editor update', pg_temp.upsert_sql('e1', 't11v', null, 't11_a'));
  perform pg_temp.back();
  select version, updated_by into r from public.vault_entries where id = pg_temp.u('entry:e1');
  assert r.updated_by = pg_temp.u('t11_e'), format('T11: updated_by is the caller, got %s', r.updated_by);
  assert r.version = 2, format('T11: version 2 after the update, got %s', r.version);
  perform pg_temp.ok('T11');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t12_a', 'team');
  perform pg_temp.mk_user('t12_e', 'team');
  perform pg_temp.mk_team('t12', 't12_a');
  perform pg_temp.add_member('t12', 't12_a', 'admin');
  perform pg_temp.add_member('t12', 't12_e');
  perform pg_temp.mk_tvault('t12', 't12v', 't12_a');
  perform pg_temp.add_tv_member('t12v', 't12_a', 'admin');
  perform pg_temp.add_tv_member('t12v', 't12_e', 'editor');
  insert into public.vault_folders (id, vault_id, name) values
    (pg_temp.u('folder:ro'), pg_temp.u('tv:t12v'), 'Read only'),
    (pg_temp.u('folder:rw'), pg_temp.u('tv:t12v'), 'Open');
  insert into public.vault_folder_permissions (vault_id, folder_id, user_id, role)
  values (pg_temp.u('tv:t12v'), pg_temp.u('folder:ro'), pg_temp.u('t12_e'), 'viewer');
  insert into public.vault_entries (id, vault_id, name, entry_type, folder_id)
  values (pg_temp.u('entry:in-ro'), pg_temp.u('tv:t12v'), 'in-ro', 'ssh', pg_temp.u('folder:ro'));
  perform pg_temp.act('t12_e');
  perform pg_temp.expect_err('T12 into', pg_temp.upsert_sql('new', 't12v', 'ro'), '42501');
  perform pg_temp.expect_err('T12 out of', pg_temp.upsert_sql('in-ro', 't12v', 'rw'), '42501');
  perform pg_temp.expect_ok('T12 open folder', pg_temp.upsert_sql('new', 't12v', 'rw'));
  perform pg_temp.back();
  assert (select folder_id from public.vault_entries where id = pg_temp.u('entry:in-ro')) = pg_temp.u('folder:ro'),
    'T12: the entry stayed in its folder';
  perform pg_temp.ok('T12');
end $$;
rollback;

begin;
do $$ declare n bigint; begin
  perform pg_temp.mk_user('t13_a', 'team');
  perform pg_temp.mk_user('t13_m', 'team');
  perform pg_temp.mk_team('t13', 't13_a');
  perform pg_temp.add_member('t13', 't13_a', 'admin');
  perform pg_temp.add_member('t13', 't13_m');
  perform pg_temp.mk_tvault('t13', 't13v', 't13_a');
  perform pg_temp.add_tv_member('t13v', 't13_a', 'admin');
  perform pg_temp.add_tv_member('t13v', 't13_m', 'editor');
  insert into public.vault_folders (id, vault_id, name) values (pg_temp.u('folder:t13'), pg_temp.u('tv:t13v'), 'F');
  insert into public.vault_folder_permissions (vault_id, folder_id, user_id, role)
  values (pg_temp.u('tv:t13v'), pg_temp.u('folder:t13'), pg_temp.u('t13_m'), 'viewer');
  insert into public.vault_entries (id, vault_id, name, entry_type, host)
  values (pg_temp.u('entry:t13'), pg_temp.u('tv:t13v'), 'server', 'ssh', 'db.internal');
  insert into public.vault_password_history (vault_id, entry_id, username, password_encrypted, changed_by)
  values (pg_temp.u('tv:t13v'), pg_temp.u('entry:t13'), 'root', 'enc', pg_temp.u('t13_a'));
  insert into public.vault_key_wraps (team_vault_id, user_id, ephemeral_public_key_b64, encrypted_vek_b64)
  values (pg_temp.u('tv:t13v'), pg_temp.u('t13_m'), 'pk', 'vek');

  perform pg_temp.act('t13_m');
  assert (select count(*) from public.vault_entries where vault_id = pg_temp.u('tv:t13v')) = 1, 'T13: sees the entry before removal';
  perform pg_temp.back();

  delete from public.team_members where team_id = pg_temp.u('team:t13') and user_id = pg_temp.u('t13_m');

  perform pg_temp.act('t13_m');
  select count(*) into n from public.vault_entries where vault_id = pg_temp.u('tv:t13v');
  assert n = 0, format('T13: vault_entries rows %s', n);
  select count(*) into n from public.vault_password_history where vault_id = pg_temp.u('tv:t13v');
  assert n = 0, format('T13: vault_password_history rows %s', n);
  select count(*) into n from public.vault_key_wraps where team_vault_id = pg_temp.u('tv:t13v');
  assert n = 0, format('T13: vault_key_wraps rows %s', n);
  select count(*) into n from public.vault_folder_permissions where vault_id = pg_temp.u('tv:t13v');
  assert n = 0, format('T13: vault_folder_permissions rows %s', n);
  perform pg_temp.back();
  assert not exists (select 1 from public.team_vault_members where user_id = pg_temp.u('t13_m')), 'T13: team_vault_members rows gone';
  assert (select rotation_pending from public.team_vaults where id = pg_temp.u('tv:t13v')), 'T13: rotation_pending';
  perform pg_temp.ok('T13');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t14_a', 'team');
  perform pg_temp.mk_user('t14_fa', 'team');
  perform pg_temp.mk_user('t14_x', 'team');
  perform pg_temp.mk_team('t14', 't14_a');
  perform pg_temp.add_member('t14', 't14_a', 'admin');
  perform pg_temp.add_member('t14', 't14_fa', 'admin');
  perform pg_temp.add_member('t14', 't14_x');
  perform pg_temp.mk_tvault('t14', 't14v', 't14_a');
  perform pg_temp.add_tv_member('t14v', 't14_a', 'admin');
  perform pg_temp.add_tv_member('t14v', 't14_fa', 'admin');
  perform pg_temp.add_tv_member('t14v', 't14_x', 'editor');
  insert into public.vault_key_wraps (team_vault_id, user_id, ephemeral_public_key_b64, encrypted_vek_b64)
  values (pg_temp.u('tv:t14v'), pg_temp.u('t14_x'), 'pk', 'vek');
  -- A row left from before the cleanup trigger existed.
  alter table public.team_members disable trigger trg_cleanup_removed_team_member;
  delete from public.team_members where team_id = pg_temp.u('team:t14') and user_id = pg_temp.u('t14_fa');
  alter table public.team_members enable trigger trg_cleanup_removed_team_member;
  assert exists (select 1 from public.team_vault_members where user_id = pg_temp.u('t14_fa')), 'T14: stale row present';

  perform pg_temp.act('t14_fa');
  assert pg_temp.affected(format('delete from public.team_vault_members where team_vault_id = %L and user_id = %L',
    pg_temp.u('tv:t14v'), pg_temp.u('t14_x'))) = 0, 'T14: former admin deleted a member';
  assert pg_temp.affected(format('delete from public.vault_key_wraps where team_vault_id = %L and user_id = %L',
    pg_temp.u('tv:t14v'), pg_temp.u('t14_x'))) = 0, 'T14: former admin deleted a key wrap';
  perform pg_temp.back();
  perform pg_temp.ok('T14');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t15_a', 'team');
  perform pg_temp.mk_user('t15_m', 'team');
  perform pg_temp.mk_user('t15_out');
  perform pg_temp.mk_team('t15', 't15_a');
  perform pg_temp.add_member('t15', 't15_a', 'admin');
  perform pg_temp.add_member('t15', 't15_m');
  perform pg_temp.mk_tvault('t15', 't15v', 't15_a');
  perform pg_temp.add_tv_member('t15v', 't15_a', 'admin');
  perform pg_temp.act('t15_a');
  perform pg_temp.expect_err('T15', format('insert into public.vault_key_wraps (team_vault_id, user_id, ephemeral_public_key_b64, encrypted_vek_b64) values (%L, %L, %L, %L)',
    pg_temp.u('tv:t15v'), pg_temp.u('t15_out'), 'pk', 'vek'), '42501');
  perform pg_temp.expect_ok('T15', format('insert into public.vault_key_wraps (team_vault_id, user_id, ephemeral_public_key_b64, encrypted_vek_b64) values (%L, %L, %L, %L)',
    pg_temp.u('tv:t15v'), pg_temp.u('t15_m'), 'pk', 'vek'));
  perform pg_temp.back();
  perform pg_temp.ok('T15');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t16_a', 'team');
  perform pg_temp.mk_team('t16', 't16_a');
  perform pg_temp.add_member('t16', 't16_a', 'admin');
  perform pg_temp.act('t16_a');
  perform pg_temp.expect_err('T16', format('insert into public.team_invitations (team_id, email, invited_by) values (%L, %L, %L)',
    pg_temp.u('team:t16'), 'new@plan.test', pg_temp.u('t16_a')), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('T16');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('t17_a', 'team');
  perform pg_temp.mk_team('t17', 't17_a');
  perform pg_temp.add_member('t17', 't17_a', 'admin');
  insert into public.team_invitations (id, team_id, email, invited_by, status) values
    (pg_temp.u('inv:pending'), pg_temp.u('team:t17'), 'p@plan.test', pg_temp.u('t17_a'), 'pending'),
    (pg_temp.u('inv:declined'), pg_temp.u('team:t17'), 'd@plan.test', pg_temp.u('t17_a'), 'declined');
  perform pg_temp.act('t17_a');
  perform pg_temp.expect_err('T17 extend', format('update public.team_invitations set expires_at = expires_at + interval %L where id = %L',
    '30 days', pg_temp.u('inv:pending')), '42501');
  perform pg_temp.expect_err('T17 reopen', format('update public.team_invitations set status = %L where id = %L',
    'pending', pg_temp.u('inv:declined')), '42501');
  assert pg_temp.affected(format('update public.team_invitations set status = %L where id = %L',
    'expired', pg_temp.u('inv:pending'))) = 1, 'T17: an admin can still revoke';
  perform pg_temp.back();
  perform pg_temp.ok('T17');
end $$;
rollback;

-- Ownership (M3) ----------------------------------------------------------------------------------

begin;
do $$ declare r jsonb; o public.personal_vault_owners; g timestamptz; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.mk_user('ob', 'pro');
  r := pg_temp.acq('oa', 'L', 'a1');
  assert (r ->> 'granted')::boolean and r ->> 'ownership' = 'owner', format('O1: %s', r);
  assert (r ->> 'release_after')::timestamptz = now() + interval '7 days', format('O1 release_after: %s', r);
  o := pg_temp.owner_row('L');
  assert o.owner_id = pg_temp.u('oa') and o.grace_started_at is null, format('O1 owner row: %s', o);
  perform pg_temp.ok('O1');

  r := pg_temp.acq('ob', 'L', 'b1');
  assert (r ->> 'granted')::boolean and r ->> 'ownership' = 'grace', format('O2: %s', r);
  g := (r ->> 'grace_until')::timestamptz;
  assert g = now() + interval '14 days', format('O2 grace_until: %s', r);
  assert (pg_temp.owner_row('L')).grace_started_at = now(), 'O2: grace_started_at set';
  assert exists (select 1 from public.personal_vault_guest_grace
                  where account_lo = least(pg_temp.u('oa'), pg_temp.u('ob'))
                    and account_hi = greatest(pg_temp.u('oa'), pg_temp.u('ob'))), 'O2: pair row';
  r := pg_temp.hb('oa', 'L', 'a1');
  assert r ->> 'status' = 'ok' and r ->> 'ownership' = 'owner' and (r ->> 'shared_until')::timestamptz = g,
    format('O2 owner heartbeat: %s', r);
  r := pg_temp.hb('ob', 'L', 'b1');
  assert r ->> 'status' = 'ok' and r ->> 'ownership' = 'grace' and (r ->> 'grace_until')::timestamptz = g,
    format('O2 guest heartbeat: %s', r);
  perform pg_temp.ok('O2');

  update public.personal_vault_owners set grace_started_at = now() - interval '15 days' where vault_key = pg_temp.u('L');
  r := pg_temp.acq('ob', 'L', 'b2');
  assert not (r ->> 'granted')::boolean and r ->> 'reason' = 'not_owner' and not (r ->> 'released')::boolean
     and (r ->> 'grace_ended_at')::timestamptz = now() - interval '1 day', format('O3: %s', r);
  assert jsonb_array_length(r -> 'holders') = 0, 'O3: empty holders';
  assert (pg_temp.sess('ob', 'L', 'b2')).user_id is null, 'O3: no session row';
  perform pg_temp.ok('O3');

  r := pg_temp.hb('ob', 'L', 'b1');
  assert r ->> 'status' = 'displaced' and r ->> 'reason' = 'not_owner' and r -> 'by' = 'null'::jsonb
     and not (r ->> 'released')::boolean and r ? 'grace_ended_at', format('O4: %s', r);
  assert (pg_temp.sess('ob', 'L', 'b1')).status = 'displaced'
     and (pg_temp.sess('ob', 'L', 'b1')).displaced_reason = 'not_owner', 'O4: row displaced';
  r := pg_temp.hb('ob', 'L', 'b1');
  assert r ->> 'reason' = 'not_owner', format('O4 repeat: %s', r);
  perform pg_temp.ok('O4');
end $$;
rollback;

begin;
do $$ declare r jsonb; o public.personal_vault_owners; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.mk_user('ob', 'pro');
  perform pg_temp.acq('oa', 'L', 'a1');
  perform pg_temp.acq('ob', 'L', 'b1');
  r := pg_temp.release('oa', 'L');
  assert r = jsonb_build_object('released', false, 'reason', 'too_soon', 'retry_after', now() + interval '7 days'),
    format('O5: %s', r);
  r := pg_temp.release('ob', 'L');
  assert r = '{"released": false, "reason": "not_owner"}'::jsonb, format('O5 guest: %s', r);
  perform pg_temp.ok('O5');

  update public.personal_vault_owners set owner_since = now() - interval '8 days' where vault_key = pg_temp.u('L');
  r := pg_temp.release('oa', 'L');
  assert r = '{"released": true}'::jsonb, format('O6 release: %s', r);
  o := pg_temp.owner_row('L');
  assert o.owner_id is null and o.owner_since is null and o.released_by = pg_temp.u('oa') and o.released_at = now(),
    format('O6 row after release: %s', o);
  r := pg_temp.acq('ob', 'L', 'b1');
  assert (r ->> 'granted')::boolean and r ->> 'ownership' = 'owner', format('O6 acquire: %s', r);
  o := pg_temp.owner_row('L');
  assert o.owner_id = pg_temp.u('ob') and o.released_at is null and o.released_by = pg_temp.u('oa'), format('O6 new owner: %s', o);
  perform pg_temp.ok('O6');

  -- O13: the ex-owner's grace is over.
  update public.personal_vault_owners set grace_started_at = now() - interval '15 days' where vault_key = pg_temp.u('L');
  r := pg_temp.acq('oa', 'L', 'a3');
  assert not (r ->> 'granted')::boolean and r ->> 'reason' = 'not_owner' and (r ->> 'released')::boolean, format('O13 acquire: %s', r);
  assert (pg_temp.sess('oa', 'L', 'a3')).user_id is null, 'O13: no session row';
  r := pg_temp.hb('oa', 'L', 'a1');
  assert r ->> 'status' = 'displaced' and r ->> 'reason' = 'not_owner' and (r ->> 'released')::boolean, format('O13 heartbeat: %s', r);
  perform pg_temp.ok('O13');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.acq('oa', 'L', 'a1');
  perform pg_temp.acq('oa', 'L', 'a2');
  update public.personal_vault_owners set owner_since = now() - interval '8 days' where vault_key = pg_temp.u('L');
  r := pg_temp.release('oa', 'L');
  assert (r ->> 'released')::boolean, format('O7 release: %s', r);
  r := pg_temp.hb('oa', 'L', 'a2');
  assert r ->> 'status' = 'ok' and r ->> 'ownership' = 'unowned', format('O7 heartbeat: %s', r);
  r := pg_temp.acq('oa', 'L', 'a2', false, false);
  assert (r ->> 'granted')::boolean and r ->> 'ownership' = 'unowned', format('O7 re-acquire: %s', r);
  assert (pg_temp.owner_row('L')).owner_id is null, 'O7: still no owner';
  -- The next user-started open claims it again (S12).
  r := pg_temp.acq('oa', 'L', 'a1');
  assert r ->> 'ownership' = 'owner' and (pg_temp.owner_row('L')).owner_id = pg_temp.u('oa'), format('O7 claim: %s', r);
  perform pg_temp.ok('O7');
end $$;
rollback;

begin;
do $$ declare o public.personal_vault_owners; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.mk_user('ob', 'pro');
  perform pg_temp.acq('oa', 'L', 'a1');
  perform pg_temp.acq('ob', 'L', 'b1');
  delete from auth.users where id = pg_temp.u('oa');
  o := pg_temp.owner_row('L');
  assert o.vault_key is not null and o.owner_id is null and o.owner_since is null and o.released_at is not null,
    format('O8: %s', o);
  assert not exists (select 1 from public.personal_vault_guest_grace
                      where pg_temp.u('oa') in (account_lo, account_hi)), 'O8: pair rows gone';
  perform pg_temp.ok('O8');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.mk_user('ob', 'pro');
  perform pg_temp.acq('oa', 'L1', 'a1');
  perform pg_temp.acq('ob', 'L1', 'b1');
  update public.personal_vault_owners set grace_started_at = now() - interval '15 days' where vault_key = pg_temp.u('L1');
  update public.personal_vault_guest_grace set started_at = now() - interval '15 days';
  r := pg_temp.acq('ob', 'L2', 'b1');
  assert r ->> 'ownership' = 'owner', format('O10 fork owner: %s', r);
  r := pg_temp.acq('oa', 'L2', 'a1');
  assert not (r ->> 'granted')::boolean and r ->> 'reason' = 'not_owner', format('O10: %s', r);
  assert (pg_temp.sess('oa', 'L2', 'a1')).user_id is null, 'O10: no session row';
  assert (pg_temp.owner_row('L2')).grace_started_at is null, 'O10: the refused acquire wrote nothing';
  perform pg_temp.ok('O10');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('oa', 'pro');
  r := pg_temp.acq('oa', 'L', 'a1', false, false);
  assert (r ->> 'granted')::boolean and r ->> 'ownership' = 'unowned', format('O11: %s', r);
  assert (pg_temp.owner_row('L')).vault_key is null, 'O11: no owner row';
  perform pg_temp.ok('O11');
end $$;
rollback;

begin;
do $$ declare r jsonb; o public.personal_vault_owners; i int; begin
  perform pg_temp.mk_user('oa', 'pro');
  perform pg_temp.mk_user('ob', 'pro');
  perform pg_temp.acq('oa', 'L', 'a1');
  for i in 1..5 loop perform pg_temp.live('ob', 'W' || i, 'b' || i, make_interval(mins => i)); end loop;
  o := pg_temp.owner_row('L');
  r := pg_temp.acq('ob', 'L', 'b6');
  assert r ->> 'reason' = 'device_cap', format('O12 device_cap: %s', r);
  update public.user_profiles set tier_id = (select id from public.tiers where name = 'free') where id = pg_temp.u('ob');
  perform pg_temp.live('ob', 'L', 'bx', interval '1 minute');
  r := pg_temp.acq('ob', 'L', 'b6');
  assert r ->> 'reason' = 'vault_limit', format('O12 vault_limit: %s', r);
  r := pg_temp.acq('ob', 'R', 'b7');
  assert r ->> 'reason' = 'device_cap', format('O12 random lineage: %s', r);
  assert pg_temp.owner_row('L') is not distinct from o, 'O12: owner row of L changed';
  assert (pg_temp.owner_row('L')).grace_started_at is null, 'O12: grace_started_at set';
  assert not exists (select 1 from public.personal_vault_guest_grace), 'O12: pair row written';
  assert (pg_temp.owner_row('R')).vault_key is null, 'O12: owner row for R';
  perform pg_temp.ok('O12');
end $$;
rollback;

-- Device cap (M3) ---------------------------------------------------------------------------------

begin;
do $$ declare r jsonb; i int; begin
  perform pg_temp.mk_user('dp', 'pro');
  -- d1 is the oldest but busy; d2 is the least recent idle device and holds two vaults.
  perform pg_temp.live('dp', 'V1', 'd1', interval '50 minutes', '{"sessions": 2}');
  perform pg_temp.live('dp', 'V2', 'd2', interval '40 minutes');
  perform pg_temp.live('dp', 'V2b', 'd2', interval '45 minutes');
  for i in 3..5 loop perform pg_temp.live('dp', 'V' || i, 'd' || i, make_interval(mins => 40 - i * 5)); end loop;

  r := pg_temp.peek('dp', 'V6', 'd6', 'macos', '0.18.0');
  assert r ->> 'reason' = 'device_cap' and jsonb_array_length(r -> 'devices') = 5 and (r ->> 'device_cap')::int = 5,
    format('D5: %s', r);
  perform pg_temp.ok('D5');

  r := pg_temp.acq('dp', 'V6', 'd6');
  assert not (r ->> 'granted')::boolean and r ->> 'reason' = 'device_cap' and (r ->> 'device_cap')::int = 5
     and jsonb_array_length(r -> 'holders') = 5, format('D1: %s', r);
  assert (r -> 'holders' -> 0 ->> 'device_id')::uuid = pg_temp.u('d2') and (r -> 'holders' -> 0 ->> 'vaults')::int = 2,
    format('D1 holders[0]: %s', r -> 'holders' -> 0);
  assert (r -> 'holders' -> 4 ->> 'device_id')::uuid = pg_temp.u('d1'), 'D1: the busy device is last';
  assert (pg_temp.sess('dp', 'V6', 'd6')).user_id is null, 'D1: no session row';
  perform pg_temp.ok('D1');

  r := pg_temp.acq('dp', 'V1b', 'd1');
  assert (r ->> 'granted')::boolean, format('D3: %s', r);
  perform pg_temp.ok('D3');

  r := pg_temp.acq('dp', 'V6', 'd6', true);
  assert (r ->> 'granted')::boolean, format('D2: %s', r);
  assert (select bool_and(status = 'displaced' and displaced_reason = 'device_cap' and displaced_by_device = pg_temp.u('d6'))
            from public.personal_vault_sessions where user_id = pg_temp.u('dp') and device_id = pg_temp.u('d2')),
    'D2: every row of d2 displaced with device_cap';
  assert (select count(*) from public.personal_vault_sessions where user_id = pg_temp.u('dp') and status = 'displaced') = 2,
    'D2: only d2 displaced';
  perform pg_temp.ok('D2');

  r := pg_temp.hb('dp', 'V2', 'd2');
  assert r ->> 'status' = 'displaced' and r ->> 'reason' = 'device_cap' and r ->> 'by' = 'dev-d6', format('D8: %s', r);
  perform pg_temp.ok('D8');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('dp', 'pro');
  perform pg_temp.live('dp', 'V1', 'd1', interval '50 minutes', '{"jobs": 1}');
  perform pg_temp.live('dp', 'V2', 'd2', interval '10 minutes');
  perform pg_temp.live('dp', 'V3', 'd3', interval '20 minutes');
  perform pg_temp.live('dp', 'V4', 'd4', interval '30 minutes');
  r := pg_temp.acq('dp', 'V5', 'h');
  assert (r ->> 'granted')::boolean, format('D4 setup: %s', r);
  update public.tiers set features = features || '{"account_max_active_devices": 2}' where name = 'pro';
  r := pg_temp.hb('dp', 'V5', 'h');
  assert r ->> 'status' = 'ok' and (r ->> 'device_cap')::int = 2, format('D4 heartbeat: %s', r);
  assert (select array_agg(device_id order by device_id) from public.personal_vault_sessions
           where user_id = pg_temp.u('dp') and status = 'active')
       = (select array_agg(x order by x) from unnest(array[pg_temp.u('d1'), pg_temp.u('h')]) x),
    'D4: the busy device and the heartbeating device stay';
  assert (select bool_and(displaced_reason = 'device_cap') from public.personal_vault_sessions
           where user_id = pg_temp.u('dp') and status = 'displaced'), 'D4: displaced with device_cap';
  perform pg_temp.ok('D4');
end $$;
rollback;

begin;
do $$ declare r jsonb; i int; begin
  perform pg_temp.mk_user('df');
  perform pg_temp.live('df', 'V', 'd1', interval '1 minute');
  for i in 2..5 loop perform pg_temp.live('df', 'W' || i, 'd' || i, make_interval(mins => 10 * i)); end loop;
  r := pg_temp.acq('df', 'V', 'd6');
  assert r ->> 'reason' = 'vault_limit' and r -> 'also_locks' = 'null'::jsonb and (r ->> 'device_cap')::int = 5
     and jsonb_array_length(r -> 'holders') = 1, format('D6: %s', r);
  r := pg_temp.acq('df', 'V', 'd6', true);
  assert (r ->> 'granted')::boolean, format('D6 takeover: %s', r);
  assert (select array_agg(device_id) from public.personal_vault_sessions where user_id = pg_temp.u('df') and status = 'displaced')
       = array[pg_temp.u('d1')], 'D6: only the holder displaced';
  assert (pg_temp.sess('df', 'V', 'd1')).displaced_reason = 'takeover', 'D6: reason takeover';
  perform pg_temp.ok('D6');
end $$;
rollback;

begin;
do $$ declare r jsonb; i int; begin
  perform pg_temp.mk_user('df');
  perform pg_temp.live('df', 'V', 'd1', interval '1 minute');
  perform pg_temp.live('df', 'W1', 'd1', interval '2 minutes');
  for i in 2..5 loop perform pg_temp.live('df', 'W' || i, 'd' || i, make_interval(mins => 10 * i)); end loop;
  r := pg_temp.acq('df', 'V', 'd6');
  assert r ->> 'reason' = 'vault_limit' and (r -> 'also_locks' ->> 'device_id')::uuid = pg_temp.u('d5')
     and r -> 'also_locks' ->> 'device_name' = 'dev-d5', format('D7: %s', r);
  r := pg_temp.acq('df', 'V', 'd6', true);
  assert (r ->> 'granted')::boolean, format('D7 takeover: %s', r);
  assert (pg_temp.sess('df', 'V', 'd1')).displaced_reason = 'takeover', 'D7: holder displaced on V';
  assert (pg_temp.sess('df', 'W1', 'd1')).status = 'active', 'D7: holder keeps its other vault';
  assert (pg_temp.sess('df', 'W5', 'd5')).displaced_reason = 'device_cap', 'D7: d5 displaced by the cap';
  perform pg_temp.ok('D7');
end $$;
rollback;

-- Minimum app version (M2, M3) --------------------------------------------------------------------

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('vu', 'pro');
  perform pg_temp.set_min('0.19.0', '0.0.0');
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', '0.18.2');
  assert not (r ->> 'granted')::boolean and r ->> 'reason' = 'update_required' and r ->> 'min_version' = '0.19.0'
     and jsonb_array_length(r -> 'holders') = 0, format('V1: %s', r);
  assert (pg_temp.sess('vu', 'V', 'd1')).user_id is null, 'V1: no session row';
  r := pg_temp.peek('vu', 'V', 'd1', 'macos', '0.18.2');
  assert r ->> 'reason' = 'update_required' and r ->> 'min_version' = '0.19.0', format('V1 peek: %s', r);
  r := pg_temp.peek('vu', 'V', 'd1');
  assert not r ? 'reason', format('V1 peek without platform: %s', r);
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', '0.19.0');
  assert (r ->> 'granted')::boolean, format('V1 at the minimum: %s', r);
  perform pg_temp.ok('V1');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('vu', 'pro');
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', '0.18.2');
  assert (r ->> 'granted')::boolean, format('V2 setup: %s', r);
  perform pg_temp.set_min('0.19.0', '0.0.0');
  r := pg_temp.hb('vu', 'V', 'd1');
  assert r ->> 'status' = 'displaced' and r ->> 'reason' = 'update_required' and r ->> 'min_version' = '0.19.0'
     and r -> 'by' = 'null'::jsonb, format('V2: %s', r);
  assert (pg_temp.sess('vu', 'V', 'd1')).displaced_reason = 'update_required', 'V2: row displaced';
  r := pg_temp.hb('vu', 'V', 'd1');
  assert r ->> 'reason' = 'update_required' and r ->> 'min_version' = '0.19.0', format('V2 repeat: %s', r);
  perform pg_temp.ok('V2');
end $$;
rollback;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('vu', 'pro');
  perform pg_temp.set_min('0.19.0', '0.0.0');
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', 'abc');
  assert r ->> 'reason' = 'update_required', format('V3 unparseable: %s', r);
  perform pg_temp.set_min('0.0.0', '0.0.0');
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', 'abc');
  assert (r ->> 'granted')::boolean, format('V3 no minimum: %s', r);
  perform pg_temp.ok('V3');
end $$;
rollback;

do $$ begin
  assert public.version_parts('1.1.0 (107)') = array[1, 1, 0], 'V4: 1.1.0 (107)';
  assert public.version_parts('v0.18') = array[0, 18, 0], 'V4: v0.18';
  assert public.version_parts('') is null, 'V4: empty';
  assert public.version_parts('abc') is null, 'V4: abc';
  assert public.version_parts(null) is null, 'V4: null';
  assert public.version_parts('0.18.2') >= array[0, 17, 9], 'V4: element-wise compare';
  assert not (public.version_parts('0.9.9') >= array[0, 10, 0]), 'V4: 0.9.9 < 0.10.0';
  perform pg_temp.ok('V4');
end $$;

begin;
do $$ declare r jsonb; begin
  perform pg_temp.mk_user('vu', 'pro');
  perform pg_temp.set_min('0.0.0', '1.2.0');
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'x', '9.9.9');
  assert r ->> 'reason' = 'update_required', format('V5 unknown platform: %s', r);
  r := pg_temp.acq('vu', 'V', 'd1', false, true, null, '9.9.9');
  assert r ->> 'reason' = 'update_required', format('V5 null platform: %s', r);
  r := pg_temp.acq('vu', 'V', 'd1', false, true, 'macos', '0.1.0');
  assert (r ->> 'granted')::boolean, format('V5 desktop unaffected: %s', r);
  r := pg_temp.acq('vu', 'V', 'd2', false, true, 'ipados', '1.1.9');
  assert r ->> 'reason' = 'update_required' and r ->> 'min_version' = '1.2.0', format('V5 ipados: %s', r);
  perform pg_temp.set_min('0.0.0', '0.0.0');
  assert public.app_version_ok('x', '1.0.0') and public.app_version_ok(null, null), 'V5: no minimum lets any platform pass';
  -- Past the version check an unknown platform still meets the table's platform check (spec contradiction, see runner notes).
  perform pg_temp.act('vu');
  perform pg_temp.expect_err('V5', format('select public.vault_session_acquire(%L, %L, gen_random_uuid(), %L, %L, %L, null, null, null)',
    pg_temp.u('V'), pg_temp.u('d3'), 'dev', 'x', '1.0.0'), '23514');
  perform pg_temp.back();
  perform pg_temp.ok('V5');
end $$;
rollback;

-- Cloud backup (M4, M5) ---------------------------------------------------------------------------

begin;
do $$ declare v text := pg_temp.u('vault-1')::text; begin
  perform pg_temp.mk_user('cf');
  perform pg_temp.seed_obj('cf', v || '/vault.enc');
  perform pg_temp.act('cf');
  perform pg_temp.expect_err('C1 insert', pg_temp.put_sql('cf', pg_temp.u('vault-2')::text || '/vault.enc'), '42501');
  perform pg_temp.expect_err('C1 upsert', pg_temp.put_sql('cf', v || '/vault.enc')
    || ' on conflict (bucket_id, name) do update set updated_at = now()', '42501');
  perform pg_temp.expect_err('C1 update', format('update storage.objects set updated_at = now() where bucket_id = %L and name = %L',
    'vaults', pg_temp.obj('cf', v || '/vault.enc')), '42501');
  perform pg_temp.back();
  perform pg_temp.ok('C1');
end $$;
rollback;

begin;
do $$ begin
  perform pg_temp.mk_user('ct');
  update public.user_profiles set is_team_member = true where id = pg_temp.u('ct');
  perform pg_temp.act('ct');
  perform pg_temp.expect_ok('C2', pg_temp.put_sql('ct', pg_temp.u('vault-1')::text || '/vault.enc'));
  perform pg_temp.back();
  perform pg_temp.ok('C2');
end $$;
rollback;

begin;
do $$ declare v1 text := pg_temp.u('vault-1')::text; v2 text := pg_temp.u('vault-2')::text; i int; begin
  perform pg_temp.mk_user('cp', 'pro');
  perform pg_temp.seed_obj('cp', v1 || '/vault.enc');
  for i in 1..25 loop
    perform pg_temp.seed_obj('cp', v1 || format('/backups/vault_2026-09-%s_10-00-00-000_aaaaaa.enc', lpad(i::text, 2, '0')));
  end loop;
  perform pg_temp.act('cp');
  perform pg_temp.expect_err('C3', pg_temp.put_sql('cp', v1 || '/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc'), '42501');
  perform pg_temp.expect_ok('C3', pg_temp.put_sql('cp', v2 || '/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc'));
  perform pg_temp.ok('C3');

  assert pg_temp.affected(format('update storage.objects set updated_at = now(), metadata = %L where bucket_id = %L and name = %L',
    '{"size": 1}', 'vaults', pg_temp.obj('cp', v1 || '/backups/vault_2026-09-03_10-00-00-000_aaaaaa.enc'))) = 1,
    'C7: overwrite of an existing snapshot';
  perform pg_temp.expect_err('C7', format('update storage.objects set name = %L where bucket_id = %L and name = %L',
    pg_temp.obj('cp', v1 || '/backups/vault_2026-09-27_10-00-00-000_bbbbbb.enc'), 'vaults', pg_temp.obj('cp', v1 || '/vault.enc')),
    '42501');
  perform pg_temp.back();
  perform pg_temp.ok('C7');
end $$;
rollback;

begin;
do $$ declare n bigint; begin
  perform pg_temp.mk_user('cf');
  perform pg_temp.seed_obj('cf', 'vault.enc');
  perform pg_temp.seed_obj('cf', 'backups/vault_2026-02-17_21-36-10.enc');
  perform pg_temp.act('cf');
  select count(*) into n from storage.objects where bucket_id = 'vaults';
  assert n = 2, format('C4: reads %s objects', n);
  perform set_config('storage.allow_delete_query', 'true', true);
  assert pg_temp.affected(format('delete from storage.objects where bucket_id = %L and name like %L',
    'vaults', pg_temp.u('cf')::text || '/%')) = 2, 'C4: deletes both';
  perform pg_temp.back();
  perform pg_temp.ok('C4');
end $$;
rollback;

begin;
do $$ declare v text := pg_temp.u('vault-1')::text; begin
  perform pg_temp.mk_user('cp', 'pro');
  perform pg_temp.act('cp');
  perform pg_temp.expect_err('C5 x.bin', pg_temp.put_sql('cp', v || '/x.bin'), '42501');
  perform pg_temp.expect_err('C5 nested', pg_temp.put_sql('cp', v || '/backups/a/b.enc'), '42501');
  perform pg_temp.expect_err('C5 other', pg_temp.put_sql('cp', 'other.enc'), '42501');
  perform pg_temp.expect_err('C5 other folder', format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)',
    'vaults', pg_temp.u('someone')::text || '/vault.enc', pg_temp.u('cp')), '42501');
  perform pg_temp.expect_ok('C5 snapshot', pg_temp.put_sql('cp', v || '/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc'));
  perform pg_temp.expect_ok('C5 legacy snapshot', pg_temp.put_sql('cp', 'backups/vault_2026-02-17_21-36-10.enc'));
  perform pg_temp.expect_ok('C5 manifest', pg_temp.put_sql('cp', 'manifest.json'));
  perform pg_temp.expect_ok('C5 legacy vault', pg_temp.put_sql('cp', 'vault.enc'));
  perform pg_temp.back();
  perform pg_temp.ok('C5');
end $$;
rollback;

begin;
do $$ declare i int; begin
  perform pg_temp.mk_user('cp', 'pro');
  for i in 1..10 loop perform pg_temp.seed_obj('cp', pg_temp.u('vault-' || i)::text || '/vault.enc'); end loop;
  perform pg_temp.act('cp');
  perform pg_temp.expect_err('C6', pg_temp.put_sql('cp', pg_temp.u('vault-11')::text || '/vault.enc'), '42501');
  perform pg_temp.expect_ok('C6', pg_temp.put_sql('cp', pg_temp.u('vault-3')::text || '/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc'));
  perform pg_temp.back();
  perform pg_temp.ok('C6');
end $$;
rollback;

do $$ begin
  assert pg_get_function_identity_arguments('public.cloud_backup_allowed()'::regprocedure) = '', 'C8: cloud_backup_allowed';
  assert (select pg_get_function_identity_arguments(p.oid) from pg_proc p
           where p.oid = 'public.cloud_backup_slot_free(text)'::regprocedure) = 'p_name text', 'C8: cloud_backup_slot_free';
  assert (select count(*) from pg_proc where proname in ('cloud_backup_allowed', 'cloud_backup_slot_free')
           and pronamespace = 'public'::regnamespace) = 2, 'C8: one overload each';
  perform pg_temp.ok('C8');
end $$;

\echo all SQL cases passed
