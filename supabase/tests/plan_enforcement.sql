-- SQL tests for docs/PLAN_ENFORCEMENT.md section 7.1 (ownership, device cap, minimum version, cloud
-- backup; team hardening is in plan_enforcement_team.sql). Run by scripts/verify/run-sql-tests.mjs
-- (npm run test:sql) against the local stack after supabase/migrations and supabase/pending. Every case
-- runs in begin ... rollback and prints "ok <id>"; the first failed assert stops the run (ON_ERROR_STOP).
-- The concurrent case O9 and the PostgREST cases (H1, H2) live in the runner.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
\ir _plan_enforcement_helpers.sql

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

\echo all ownership, device cap, version and cloud SQL cases passed
