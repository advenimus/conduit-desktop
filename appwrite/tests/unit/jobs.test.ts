import { describe, expect, it } from 'vitest';
import { nightly, userCreated, userDeleted } from '../../src/api/jobs.ts';
import { u, World } from './harness.ts';

const deps = (w: World) => ({ store: w.store, files: w.files, directory: w.directory, effects: w.fx, now: () => w.clock });

describe('user events and nightly job', () => {
  it('a new user gets a Free profile named from prefs, name or email', async () => {
    const w = await World.create();
    w.users.set(u('n1'), 'first.last@x.test');
    w.users.set(u('n2'), 'a@x.test');
    await userCreated(deps(w), { $id: u('n1'), email: 'first.last@x.test', name: '' });
    await userCreated(deps(w), { $id: u('n2'), email: 'a@x.test', name: 'Named', prefs: { display_name: 'From prefs' } });
    await userCreated(deps(w), { $id: u('n2'), email: 'a@x.test', name: 'again' });
    const free = (await w.rows('tiers', [{ column: 'name', op: 'eq', value: 'free' }]))[0]!;
    expect(await w.row('user_profiles', { id: u('n1') })).toMatchObject({ display_name: 'first.last', tier_id: free.id });
    expect(await w.row('user_profiles', { id: u('n2') })).toMatchObject({ display_name: 'From prefs' });
    expect(w.effects.filter((e) => e.kind === 'new-profile')).toHaveLength(2);
  });

  it('O8: deleting the owner frees the vault and drops the guest pairs', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    await w.acq('oa', 'L', 'a1');
    await w.acq('ob', 'L', 'b1');
    w.users.delete(u('oa'));
    await userDeleted(deps(w), u('oa'));
    const o = (await w.ownerRow('L'))!;
    expect(o).toMatchObject({ owner_id: null, owner_since: null, released_at: w.nowIso });
    expect(await w.rows('personal_vault_guest_grace')).toEqual([]);
    expect(await w.row('user_profiles', { id: u('oa') })).toBeNull();
    expect((await w.rows('personal_vault_sessions')).map((s) => s.user_id)).toEqual([u('ob')]);
  });

  it('nightly purges old audit rows and stale leases only', async () => {
    const w = await World.create();
    await w.mkUser('a', 'team');
    await w.mkTeam('t', 'a');
    await w.addMember('t', 'a', 'admin');
    await w.insert('vault_audit_log', [
      { team_id: u('team:t'), actor_id: u('a'), actor_email: 'a@plan.test', action: 'vault_access', created_at: w.ago(800 * 86_400) },
      { team_id: u('team:t'), actor_id: u('a'), actor_email: 'a@plan.test', action: 'vault_access', created_at: w.ago(10 * 86_400) },
    ]);
    await w.live('a', 'V1', 'd1', 60);
    await w.update('personal_vault_sessions', { heartbeat_at: w.ago(31 * 86_400) }, [{ column: 'user_id', op: 'eq', value: u('a') }]);
    await w.live('a', 'V2', 'd2', 60);
    expect(await nightly(deps(w))).toEqual({ vault_audit_log: 1, personal_vault_sessions: 1, rate_limits: 0 });
    expect(await w.rows('vault_audit_log')).toHaveLength(1);
    expect((await w.rows('personal_vault_sessions')).map((s) => s.vault_key)).toEqual([u('V2')]);
  });
});
