import { describe, expect, it } from 'vitest';
import type { ApiRequest } from '../../src/api/handler.ts';
import { u, World } from './harness.ts';

// Port of supabase/tests/plan_enforcement_team.sql (T1-T17) plus the T4 seat race.

const ins = (table: string, rows: Record<string, unknown>): ApiRequest => ({ kind: 'query', op: 'insert', table, rows });
const upd = (table: string, values: Record<string, unknown>, filters: [string, unknown][]): ApiRequest => ({
  kind: 'query', op: 'update', table, values, filters: filters.map(([column, value]) => ({ column, op: 'eq', value })), returning: true,
});
const del = (table: string, filters: [string, unknown][]): ApiRequest => ({
  kind: 'query', op: 'delete', table, filters: filters.map(([column, value]) => ({ column, op: 'eq', value })), returning: true,
});
const sel = (table: string, filters: [string, unknown][] = []): ApiRequest => ({
  kind: 'query', op: 'select', table, filters: filters.map(([column, value]) => ({ column, op: 'eq', value })),
});
const upsertEntry = (entry: string, vault: string, folder: string | null = null, updatedBy: string | null = null): ApiRequest => ({
  kind: 'rpc',
  fn: 'upsert_vault_entry_versioned',
  args: {
    p_id: u(`entry:${entry}`), p_vault_id: u(`tv:${vault}`), p_name: entry, p_entry_type: 'ssh',
    p_folder_id: folder ? u(`folder:${folder}`) : null, p_updated_by: updatedBy ? u(updatedBy) : null,
  },
});
const affected = async (w: World, who: string, req: ApiRequest) => ((await w.ok(who, req)) as unknown[]).length;

describe('team hardening', () => {
  it('T1, T2: nobody adds team members directly', async () => {
    const w = await World.create();
    await w.mkUser('t1_x');
    await w.mkUser('t1_owner', 'team');
    await w.mkTeam('t1', 't1_owner');
    expect(await w.err('t1_x', ins('team_members', { team_id: u('team:t1'), user_id: u('t1_x'), role: 'admin' }))).toMatch(/^42501/);
    await w.mkUser('t2_b');
    await w.addMember('t1', 't1_owner', 'admin');
    expect(await w.err('t1_owner', ins('team_members', { team_id: u('team:t1'), user_id: u('t2_b'), role: 'member' }))).toMatch(/^42501/);
  });

  it('T3: seats are enforced', async () => {
    const w = await World.create();
    await w.mkUser('t3_owner', 'team');
    for (let i = 1; i <= 4; i++) await w.mkUser(`t3_m${i}`);
    await w.mkTeam('t3', 't3_owner', 3);
    for (let i = 1; i <= 3; i++) await w.ok('service', ins('team_members', { team_id: u('team:t3'), user_id: u(`t3_m${i}`) }));
    expect(await w.err('service', ins('team_members', { team_id: u('team:t3'), user_id: u('t3_m4') }))).toMatch(/^23514 team_full/);
    expect(await w.rows('team_members', [{ column: 'team_id', op: 'eq', value: u('team:t3') }])).toHaveLength(3);
  });

  it('T4: parallel adds never pass the seat count', async () => {
    const w = await World.create();
    await w.mkUser('t4_owner', 'team');
    for (let i = 1; i <= 8; i++) await w.mkUser(`t4_m${i}`);
    await w.mkTeam('t4', 't4_owner', 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => w.call('service', ins('team_members', { team_id: u('team:t4'), user_id: u(`t4_m${i + 1}`) }))),
    );
    expect(results.filter((r) => r.body.error === null)).toHaveLength(3);
    expect(results.filter((r) => r.body.error?.message.startsWith('team_full'))).toHaveLength(5);
    expect(await w.rows('team_members', [{ column: 'team_id', op: 'eq', value: u('team:t4') }])).toHaveLength(3);
  });

  it('T5: member rows cannot move', async () => {
    const w = await World.create();
    await w.mkUser('t5_a', 'team');
    await w.mkUser('t5_m', 'team');
    await w.mkUser('t5_z');
    await w.mkTeam('t5', 't5_a');
    await w.mkTeam('t5b', 't5_a');
    await w.addMember('t5', 't5_a', 'admin');
    await w.addMember('t5', 't5_m');
    await w.addMember('t5b', 't5_a', 'admin');
    const where: [string, unknown][] = [['team_id', u('team:t5')], ['user_id', u('t5_m')]];
    expect(await w.err('t5_a', upd('team_members', { team_id: u('team:t5b') }, where))).toMatch(/^42501/);
    expect(await w.err('t5_a', upd('team_members', { user_id: u('t5_z') }, where))).toMatch(/^42501/);
    expect(await affected(w, 't5_a', upd('team_members', { role: 'admin' }, where))).toBe(1);
  });

  it('T6: owners cannot change seats or billing', async () => {
    const w = await World.create();
    await w.mkUser('t6_o', 'team');
    await w.mkTeam('t6', 't6_o');
    await w.addMember('t6', 't6_o', 'admin');
    expect(await w.err('t6_o', upd('teams', { max_seats: 50 }, [['id', u('team:t6')]]))).toMatch(/^42501/);
    expect(await w.err('t6_o', upd('teams', { stripe_subscription_id: 'sub_other' }, [['id', u('team:t6')]]))).toMatch(/^42501/);
    expect(await affected(w, 't6_o', upd('teams', { name: 'Renamed' }, [['id', u('team:t6')]]))).toBe(1);
    expect((await w.rows('teams'))[0]!.max_seats).toBe(5);
  });

  it('T7: outsiders cannot join a vault', async () => {
    const w = await World.create();
    await w.mkUser('t7_a', 'team');
    await w.mkUser('t7_n');
    await w.mkTeam('t7', 't7_a');
    await w.addMember('t7', 't7_a', 'admin');
    await w.mkVault('t7', 't7v', 't7_a');
    expect(await w.err('t7_n', ins('team_vault_members', { team_vault_id: u('tv:t7v'), user_id: u('t7_n'), role: 'admin' }))).toMatch(/^42501/);
  });

  it('T8: creating vaults and the bootstrap admin row', async () => {
    const w = await World.create();
    await w.mkUser('t8_a', 'team');
    await w.mkUser('t8_b', 'team');
    await w.mkTeam('t8', 't8_a');
    await w.addMember('t8', 't8_a', 'admin');
    await w.addMember('t8', 't8_b', 'admin');
    await w.ok('t8_a', ins('team_vaults', { id: u('tv:t8v'), team_id: u('team:t8'), name: 'V', created_by: u('t8_a') }));
    await w.ok('t8_a', ins('team_vault_members', { team_vault_id: u('tv:t8v'), user_id: u('t8_a'), role: 'admin' }));
    expect(await w.err('t8_a', ins('team_vaults', { id: u('tv:t8w'), team_id: u('team:t8'), name: 'W', created_by: u('t8_b') }))).toMatch(/^42501/);
    await w.mkVault('t8', 't8x', 't8_a');
    expect(await w.err('t8_b', ins('team_vault_members', { team_vault_id: u('tv:t8x'), user_id: u('t8_b'), role: 'admin' }))).toMatch(/^42501/);
  });

  it('T9: vault admins add team members only; rows cannot move', async () => {
    const w = await World.create();
    await w.mkUser('t9_a', 'team');
    await w.mkUser('t9_m', 'team');
    await w.mkUser('t9_out');
    await w.mkTeam('t9', 't9_a');
    await w.addMember('t9', 't9_a', 'admin');
    await w.addMember('t9', 't9_m');
    await w.mkVault('t9', 't9v', 't9_a');
    await w.addVaultMember('t9v', 't9_a', 'admin');
    expect(await w.err('t9_a', ins('team_vault_members', { team_vault_id: u('tv:t9v'), user_id: u('t9_out'), role: 'viewer' }))).toMatch(/^42501/);
    await w.ok('t9_a', ins('team_vault_members', { team_vault_id: u('tv:t9v'), user_id: u('t9_m'), role: 'viewer' }));
    const where: [string, unknown][] = [['team_vault_id', u('tv:t9v')], ['user_id', u('t9_m')]];
    expect(await w.err('t9_a', upd('team_vault_members', { user_id: u('t9_out') }, where))).toMatch(/^42501/);
    expect(await w.err('t9_a', upd('team_vault_members', { team_vault_id: crypto.randomUUID() }, where))).toMatch(/^42501/);
    expect(await affected(w, 't9_a', upd('team_vault_members', { role: 'editor' }, where))).toBe(1);
    expect(w.effects.filter((e) => e.kind === 'vault-membership').map((e) => e.args)).toContainEqual([u('tv:t9v'), u('t9_m'), 'editor']);
  });

  it('T10: no seats without an active plan', async () => {
    const w = await World.create();
    await w.mkUser('t10_o', 'team');
    await w.mkTeam('t10', 't10_o', 5, null);
    expect(await w.err('service', ins('team_members', { team_id: u('team:t10'), user_id: u('t10_o'), role: 'admin' }))).toMatch(/^23514 team_inactive/);
  });

  it('T11: only current editors write entries, as themselves', async () => {
    const w = await World.create();
    for (const [n] of [['t11_a'], ['t11_e'], ['t11_v'], ['t11_r']]) await w.mkUser(n!, 'team');
    await w.mkUser('t11_out');
    await w.mkTeam('t11', 't11_a');
    await w.addMember('t11', 't11_a', 'admin');
    for (const n of ['t11_e', 't11_v', 't11_r']) await w.addMember('t11', n);
    await w.mkVault('t11', 't11v', 't11_a');
    await w.addVaultMember('t11v', 't11_a', 'admin');
    await w.addVaultMember('t11v', 't11_e', 'editor');
    await w.addVaultMember('t11v', 't11_v', 'viewer');
    await w.addVaultMember('t11v', 't11_r', 'editor');
    const tm = (await w.rows('team_members', [{ column: 'user_id', op: 'eq', value: u('t11_r') }]))[0]!;
    // Delete with the cleanup trigger off, like the SQL test: a leftover vault row from before it existed.
    await w.store.commit([{ kind: 'delete', spec: (await import('../../src/schema/tables.ts')).tableSpec('team_members'), rowId: tm.id as string, row: null }], new Map());
    expect(await w.err('t11_v', upsertEntry('e1', 't11v'))).toMatch(/^42501/);
    expect(await w.err('t11_r', upsertEntry('e1', 't11v'))).toMatch(/^42501/);
    expect(await w.err('t11_out', upsertEntry('e1', 't11v'))).toMatch(/^42501/);
    await w.ok('t11_e', upsertEntry('e1', 't11v', null, 't11_a'));
    expect(await w.ok('t11_e', upsertEntry('e1', 't11v', null, 't11_a'))).toEqual([{ success: true, current_version: 2 }]);
    const e = (await w.rows('vault_entries'))[0]!;
    expect(e).toMatchObject({ updated_by: u('t11_e'), version: 2 });
  });

  it('T12: folder grants restrict the RPC', async () => {
    const w = await World.create();
    await w.mkUser('t12_a', 'team');
    await w.mkUser('t12_e', 'team');
    await w.mkTeam('t12', 't12_a');
    await w.addMember('t12', 't12_a', 'admin');
    await w.addMember('t12', 't12_e');
    await w.mkVault('t12', 't12v', 't12_a');
    await w.addVaultMember('t12v', 't12_a', 'admin');
    await w.addVaultMember('t12v', 't12_e', 'editor');
    await w.insert('vault_folders', [
      { id: u('folder:ro'), vault_id: u('tv:t12v'), name: 'Read only' },
      { id: u('folder:rw'), vault_id: u('tv:t12v'), name: 'Open' },
    ]);
    await w.insert('vault_folder_permissions', { vault_id: u('tv:t12v'), folder_id: u('folder:ro'), user_id: u('t12_e'), role: 'viewer' });
    await w.insert('vault_entries', { id: u('entry:in-ro'), vault_id: u('tv:t12v'), name: 'in-ro', entry_type: 'ssh', folder_id: u('folder:ro') });
    expect(await w.err('t12_e', upsertEntry('new', 't12v', 'ro'))).toMatch(/^42501/);
    expect(await w.err('t12_e', upsertEntry('in-ro', 't12v', 'rw'))).toMatch(/^42501/);
    await w.ok('t12_e', upsertEntry('new', 't12v', 'rw'));
    expect((await w.row('vault_entries', { id: u('entry:in-ro') }))!.folder_id).toBe(u('folder:ro'));
  });

  it('T12b: folder grants restrict direct writes', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('e', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.addMember('t', 'e');
    await w.mkVault('t', 'v', 'a');
    await w.addVaultMember('v', 'a', 'admin');
    await w.addVaultMember('v', 'e', 'editor');
    await w.insert('vault_folders', [
      { id: u('folder:b-ro'), vault_id: u('tv:v'), name: 'Read only' },
      { id: u('folder:b-rw'), vault_id: u('tv:v'), name: 'Open' },
    ]);
    await w.insert('vault_folder_permissions', { vault_id: u('tv:v'), folder_id: u('folder:b-ro'), user_id: u('e'), role: 'viewer' });
    await w.insert('vault_entries', [
      { id: u('entry:b-ro'), vault_id: u('tv:v'), name: 'prod-db', entry_type: 'ssh', folder_id: u('folder:b-ro'), host: '10.0.0.5' },
      { id: u('entry:b-rw'), vault_id: u('tv:v'), name: 'web', entry_type: 'ssh', folder_id: u('folder:b-rw'), host: '10.0.0.6' },
    ]);
    expect(await affected(w, 'e', upd('vault_entries', { host: 'direct.example', updated_by: u('e') }, [['id', u('entry:b-ro')]]))).toBe(0);
    expect(await w.err('e', upd('vault_entries', { folder_id: u('folder:b-ro'), updated_by: u('e') }, [['id', u('entry:b-rw')]]))).toMatch(/^42501/);
    expect(await w.err('e', upd('vault_entries', { host: 'x.example', updated_by: u('a') }, [['id', u('entry:b-rw')]]))).toMatch(/^42501/);
    expect(await w.err('e', ins('vault_entries', { vault_id: u('tv:v'), name: 'new', entry_type: 'ssh', folder_id: u('folder:b-ro'), updated_by: u('e') }))).toMatch(/^42501/);
    expect(await w.err('e', ins('vault_entries', { vault_id: u('tv:v'), name: 'new', entry_type: 'ssh', folder_id: u('folder:b-rw'), updated_by: u('a') }))).toMatch(/^42501/);
    await w.ok('e', ins('vault_entries', { vault_id: u('tv:v'), name: 'new', entry_type: 'ssh', folder_id: u('folder:b-rw'), updated_by: u('e') }));
    expect(await affected(w, 'e', upd('vault_entries', { host: 'web2.internal', updated_by: u('e') }, [['id', u('entry:b-rw')]]))).toBe(1);
    expect(await w.row('vault_entries', { id: u('entry:b-ro') })).toMatchObject({ host: '10.0.0.5', updated_by: null });
  });

  it('T13: removing a member removes their vault access', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('m', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.addMember('t', 'm');
    await w.mkVault('t', 'v', 'a');
    await w.addVaultMember('v', 'a', 'admin');
    await w.addVaultMember('v', 'm', 'editor');
    await w.insert('vault_folders', { id: u('folder:t13'), vault_id: u('tv:v'), name: 'F' });
    await w.insert('vault_folder_permissions', { vault_id: u('tv:v'), folder_id: u('folder:t13'), user_id: u('m'), role: 'viewer' });
    await w.insert('vault_entries', { id: u('entry:t13'), vault_id: u('tv:v'), name: 'server', entry_type: 'ssh', host: 'db.internal' });
    await w.insert('vault_password_history', { vault_id: u('tv:v'), entry_id: u('entry:t13'), username: 'root', password_encrypted: 'enc', changed_by: u('a') });
    await w.insert('vault_key_wraps', { team_vault_id: u('tv:v'), user_id: u('m'), ephemeral_public_key_b64: 'pk', encrypted_vek_b64: 'vek' });
    expect(await w.ok('m', sel('vault_entries', [['vault_id', u('tv:v')]]))).toHaveLength(1);

    await w.ok('service', del('team_members', [['team_id', u('team:t')], ['user_id', u('m')]]));

    for (const [table, col] of [['vault_entries', 'vault_id'], ['vault_password_history', 'vault_id'], ['vault_key_wraps', 'team_vault_id'], ['vault_folder_permissions', 'vault_id']] as const) {
      expect(await w.ok('m', sel(table, [[col, u('tv:v')]]))).toHaveLength(0);
    }
    expect(await w.rows('team_vault_members', [{ column: 'user_id', op: 'eq', value: u('m') }])).toHaveLength(0);
    expect((await w.row('team_vaults', { id: u('tv:v') }))!.rotation_pending).toBe(true);
    expect((await w.row('user_profiles', { id: u('m') }))!.is_team_member).toBe(false);
    expect(w.effects).toContainEqual({ kind: 'vault-membership', args: [u('tv:v'), u('m'), null] });
  });

  it('T14: a former admin with a leftover vault row has no power', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('fa', 'team');
    await w.mkUser('x', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.addMember('t', 'fa', 'admin');
    await w.addMember('t', 'x');
    await w.mkVault('t', 'v', 'a');
    await w.addVaultMember('v', 'a', 'admin');
    await w.addVaultMember('v', 'fa', 'admin');
    await w.addVaultMember('v', 'x', 'editor');
    await w.insert('vault_key_wraps', { team_vault_id: u('tv:v'), user_id: u('x'), ephemeral_public_key_b64: 'pk', encrypted_vek_b64: 'vek' });
    await w.insert('vault_folders', { id: u('folder:t14'), vault_id: u('tv:v'), name: 'F' });
    await w.insert('vault_folder_permissions', { vault_id: u('tv:v'), folder_id: u('folder:t14'), user_id: u('x'), role: 'viewer' });
    await w.insert('vault_password_history', { vault_id: u('tv:v'), entry_id: crypto.randomUUID(), username: 'root', password_encrypted: 'enc', changed_by: u('a') });
    const tm = (await w.rows('team_members', [{ column: 'user_id', op: 'eq', value: u('fa') }]))[0]!;
    await w.store.commit([{ kind: 'delete', spec: (await import('../../src/schema/tables.ts')).tableSpec('team_members'), rowId: tm.id as string, row: null }], new Map());
    expect(await w.rows('team_vault_members', [{ column: 'user_id', op: 'eq', value: u('fa') }])).toHaveLength(1);

    expect(await affected(w, 'fa', del('team_vault_members', [['team_vault_id', u('tv:v')], ['user_id', u('x')]]))).toBe(0);
    expect(await affected(w, 'fa', del('vault_key_wraps', [['team_vault_id', u('tv:v')], ['user_id', u('x')]]))).toBe(0);
    expect(await w.ok('fa', sel('vault_password_history', [['vault_id', u('tv:v')]]))).toHaveLength(0);
    expect(await w.ok('fa', sel('vault_folder_permissions', [['vault_id', u('tv:v')]]))).toHaveLength(0);
    expect(await w.err('fa', ins('vault_password_history', { vault_id: u('tv:v'), entry_id: crypto.randomUUID(), username: 'u', changed_by: u('fa') }))).toMatch(/^42501/);
  });

  it('T15: key wraps only for team members', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('m', 'team');
    await w.mkUser('out');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.addMember('t', 'm');
    await w.mkVault('t', 'v', 'a');
    await w.addVaultMember('v', 'a', 'admin');
    expect(await w.err('a', ins('vault_key_wraps', { team_vault_id: u('tv:v'), user_id: u('out'), ephemeral_public_key_b64: 'pk', encrypted_vek_b64: 'vek' }))).toMatch(/^42501/);
    await w.ok('a', ins('vault_key_wraps', { team_vault_id: u('tv:v'), user_id: u('m'), ephemeral_public_key_b64: 'pk', encrypted_vek_b64: 'vek' }));
  });

  it('T16: admins cannot insert invitations directly', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    expect(await w.err('a', ins('team_invitations', { team_id: u('team:t'), email: 'new@plan.test', invited_by: u('a') }))).toMatch(/^42501/);
  });

  it('T17: invitations cannot be extended or reopened; invitees only accept or decline', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('p');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.insert('team_invitations', [
      { id: u('inv:pending'), team_id: u('team:t'), email: 'p@plan.test', invited_by: u('a'), status: 'pending' },
      { id: u('inv:declined'), team_id: u('team:t'), email: 'd@plan.test', invited_by: u('a'), status: 'declined' },
    ]);
    const pending = (await w.row('team_invitations', { id: u('inv:pending') }))!;
    const later = new Date(Date.parse(String(pending.expires_at)) + 30 * 86_400_000).toISOString();
    expect(await w.err('a', upd('team_invitations', { expires_at: later }, [['id', u('inv:pending')]]))).toMatch(/^42501/);
    expect(await w.err('a', upd('team_invitations', { status: 'pending' }, [['id', u('inv:declined')]]))).toMatch(/^42501/);
    // The invitee sees and answers their own invitation by email.
    expect(await w.ok('p', sel('team_invitations'))).toHaveLength(1);
    expect(await w.err('p', upd('team_invitations', { role: 'admin' }, [['id', u('inv:pending')]]))).toMatch(/^42501/);
    expect(await affected(w, 'p', upd('team_invitations', { status: 'accepted' }, [['id', u('inv:pending')]]))).toBe(1);
    expect(await affected(w, 'a', upd('team_invitations', { status: 'expired' }, [['id', u('inv:declined')]]))).toBe(1);
  });
});

describe('unique keys under races', () => {
  it('parallel inserts of the same pair: one wins, the rest get 23505', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkUser('m', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.addMember('t', 'm');
    await w.mkVault('t', 'v', 'a');
    const res = await Promise.all(
      Array.from({ length: 5 }, () => w.call('service', ins('team_vault_members', { team_vault_id: u('tv:v'), user_id: u('m'), role: 'viewer' }))),
    );
    expect(res.filter((r) => r.body.error === null)).toHaveLength(1);
    expect(res.filter((r) => r.body.error?.code === '23505')).toHaveLength(4);
  });

  it('parallel upserts on the conflict target converge on one row', async () => {
    const w = await World.create();
    await w.mkUser('k');
    const res = await Promise.all(
      ['pk1', 'pk2', 'pk3'].map((key) =>
        w.call('k', { kind: 'query', op: 'upsert', table: 'user_public_keys', onConflict: 'user_id, device_id', rows: { user_id: u('k'), device_id: 'dev-1', public_key_b64: key } }),
      ),
    );
    expect(res.every((r) => r.body.error === null)).toBe(true);
    expect(await w.rows('user_public_keys')).toHaveLength(1);
  });
});
