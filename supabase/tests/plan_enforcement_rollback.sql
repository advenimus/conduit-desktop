-- R1: the five rollback files of docs/PLAN_ENFORCEMENT.md 8.1 apply cleanly in reverse order, keep
-- every RPC signature desktop 0.18 and iOS 1.1 call, and answer well-formed. Runs in one transaction
-- that is rolled back, so the local stack keeps M1 to M5. Run by scripts/verify/run-sql-tests.mjs.

\set ON_ERROR_STOP 1
set client_min_messages = warning;
begin;
\ir ../migrations/_rollback_20261002173105_cloud_backup_count_cap.sql
\ir ../migrations/_rollback_20260929161756_cloud_backup_plan_gate.sql
\ir ../migrations/_rollback_20261001174606_vault_ownership_device_cap.sql
\ir ../migrations/_rollback_20260929161746_app_config_min_version.sql
\ir ../migrations/_rollback_20260929161642_team_membership_hardening.sql
set client_min_messages = notice;

do $$
declare
  v_uid uuid := md5('plan-enforcement-rollback:user')::uuid;
  v_vault uuid := md5('plan-enforcement-rollback:vault')::uuid;
  v_device uuid := md5('plan-enforcement-rollback:device')::uuid;
  r jsonb;
begin
  insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', 'rollback@plan.test',
          '{}'::jsonb, '{}'::jsonb, now(), now());
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  r := public.vault_session_acquire(v_vault, v_device, gen_random_uuid(), 'dev', 'macos', '0.18.0',
    'v.conduit', null, null, false, true);
  assert (r ->> 'granted')::boolean and not r ? 'ownership', format('R1 acquire (11 args): %s', r);
  r := public.vault_session_peek(p_vault_key := v_vault, p_device_id := v_device);
  assert r ? 'limit' and not r ? 'device_cap', format('R1 peek (named, 2 args): %s', r);
  r := public.vault_session_peek(v_vault, v_device, 'macos', '0.18.0');
  assert r ? 'holders', format('R1 peek (4 args): %s', r);
  r := public.vault_session_heartbeat(v_vault, v_device,
    (select lease_id from public.personal_vault_sessions where user_id = v_uid and vault_key = v_vault), true);
  assert r ->> 'status' = 'ok' and not r ? 'ownership', format('R1 heartbeat: %s', r);
  r := public.vault_owner_release(v_vault);
  assert r = '{"released": false, "reason": "not_owner"}'::jsonb, format('R1 release: %s', r);

  perform set_config('role', 'postgres', true);
  assert to_regclass('public.app_config') is null, 'R1: app_config dropped';
  assert to_regclass('public.personal_vault_owners') is not null, 'R1: owner table kept';
  assert to_regprocedure('public.vault_session_peek(uuid, uuid)') is null, 'R1: no 2-argument peek';
  assert to_regprocedure('public.vault_session_acquire(uuid, uuid, uuid, text, text, text, text, uuid, text, boolean)') is null,
    'R1: no 10-argument acquire';
  assert to_regprocedure('public.vault_owner_resolve(uuid, uuid, boolean, boolean)') is null, 'R1: resolver dropped';
  assert exists (select 1 from pg_policies where tablename = 'team_members' and policyname = 'tm_insert'), 'R1: tm_insert back';
  assert exists (select 1 from pg_policies where tablename = 'team_invitations' and policyname = 'ti_insert'), 'R1: ti_insert back';
  assert not exists (select 1 from pg_trigger where tgname in ('trg_enforce_team_seats', 'trg_guard_team_columns',
    'trg_cleanup_removed_team_member', 'trg_guard_team_member_update')), 'R1: team triggers dropped';
  assert (select position('not allowed to edit' in prosrc) > 0 from pg_proc
           where oid = to_regprocedure('public.upsert_vault_entry_versioned(uuid,uuid,text,text,uuid,integer,text,integer,text,text,text,text,text,text,text,text,text,boolean,integer,uuid,text,text,uuid)')),
    'R1: the guarded upsert stays';
  assert (select with_check from pg_policies where schemaname = 'storage' and policyname = 'Users can insert own vault')
    not like '%cloud_backup%', 'R1: folder-only insert policy';
  assert (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'Users can % own vault') = 4, 'R1: four storage policies';
  assert not exists (select 1 from public.tiers where features ? 'account_max_active_devices' or features ? 'max_cloud_backup_vaults'),
    'R1: tier keys removed';
  raise notice 'ok R1';
end $$;
rollback;
