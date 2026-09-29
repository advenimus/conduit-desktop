-- SQL tests for docs/PLAN_ENFORCEMENT.md section 7.1, team hardening (M1). Run by
-- scripts/verify/run-sql-tests.mjs (npm run test:sql) against the local stack after supabase/migrations
-- and supabase/pending. Every case runs in begin ... rollback and prints "ok <id>"; the first failed
-- assert stops the run (ON_ERROR_STOP). The concurrent case T4 lives in the runner.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
\ir _plan_enforcement_helpers.sql

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

\echo all team SQL cases passed
