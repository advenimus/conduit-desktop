import { describe, expect, it } from 'vitest';
import { days, u, World } from './harness.ts';

// Port of supabase/tests/plan_enforcement.sql (ownership O*, device cap D*, minimum version V*,
// cloud backup C*). Each case starts from a fresh world, like the SQL begin ... rollback blocks.

const iso = (w: World, secondsFromNow: number) => new Date(w.clock + secondsFromNow * 1000).toISOString();

describe('ownership', () => {
  it('O1-O4: owner, guest grace, grace over', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    let r = await w.acq('oa', 'L', 'a1');
    expect(r).toMatchObject({ granted: true, ownership: 'owner', release_after: iso(w, days(7)) });
    let o = await w.ownerRow('L');
    expect(o).toMatchObject({ owner_id: u('oa'), grace_started_at: null });

    r = await w.acq('ob', 'L', 'b1');
    expect(r).toMatchObject({ granted: true, ownership: 'grace', grace_until: iso(w, days(14)) });
    const g = r.grace_until;
    expect((await w.ownerRow('L'))!.grace_started_at).toBe(w.nowIso);
    const [lo, hi] = [u('oa'), u('ob')].sort();
    expect(await w.row('personal_vault_guest_grace', { account_lo: lo, account_hi: hi })).not.toBeNull();
    expect(await w.hb('oa', 'L', 'a1')).toMatchObject({ status: 'ok', ownership: 'owner', shared_until: g });
    expect(await w.hb('ob', 'L', 'b1')).toMatchObject({ status: 'ok', ownership: 'grace', grace_until: g });

    await w.update('personal_vault_owners', { grace_started_at: w.ago(days(15)) }, [{ column: 'vault_key', op: 'eq', value: u('L') }]);
    r = await w.acq('ob', 'L', 'b2');
    expect(r).toMatchObject({ granted: false, reason: 'not_owner', released: false, grace_ended_at: w.ago(days(1)), holders: [] });
    expect(await w.sess('ob', 'L', 'b2')).toBeNull();

    r = await w.hb('ob', 'L', 'b1');
    expect(r).toMatchObject({ status: 'displaced', reason: 'not_owner', by: null, released: false });
    expect(r).toHaveProperty('grace_ended_at');
    o = await w.sess('ob', 'L', 'b1');
    expect(o).toMatchObject({ status: 'displaced', displaced_reason: 'not_owner' });
    expect(await w.hb('ob', 'L', 'b1')).toMatchObject({ reason: 'not_owner' });
  });

  it('O5, O6, O13: release rules and the ex-owner', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    await w.acq('oa', 'L', 'a1');
    await w.acq('ob', 'L', 'b1');
    expect(await w.release('oa', 'L')).toEqual({ released: false, reason: 'too_soon', retry_after: iso(w, days(7)) });
    expect(await w.release('ob', 'L')).toEqual({ released: false, reason: 'not_owner' });

    await w.update('personal_vault_owners', { owner_since: w.ago(days(8)) }, [{ column: 'vault_key', op: 'eq', value: u('L') }]);
    expect(await w.release('oa', 'L')).toEqual({ released: true });
    expect(await w.ownerRow('L')).toMatchObject({ owner_id: null, owner_since: null, released_by: u('oa'), released_at: w.nowIso });
    expect(await w.acq('ob', 'L', 'b1')).toMatchObject({ granted: true, ownership: 'owner' });
    expect(await w.ownerRow('L')).toMatchObject({ owner_id: u('ob'), released_at: null, released_by: u('oa') });

    await w.update('personal_vault_owners', { grace_started_at: w.ago(days(15)) }, [{ column: 'vault_key', op: 'eq', value: u('L') }]);
    expect(await w.acq('oa', 'L', 'a3')).toMatchObject({ granted: false, reason: 'not_owner', released: true });
    expect(await w.sess('oa', 'L', 'a3')).toBeNull();
    expect(await w.hb('oa', 'L', 'a1')).toMatchObject({ status: 'displaced', reason: 'not_owner', released: true });
  });

  it('O7: an unowned vault, then a claim', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.acq('oa', 'L', 'a1');
    await w.acq('oa', 'L', 'a2');
    await w.update('personal_vault_owners', { owner_since: w.ago(days(8)) }, [{ column: 'vault_key', op: 'eq', value: u('L') }]);
    expect(await w.release('oa', 'L')).toMatchObject({ released: true });
    expect(await w.hb('oa', 'L', 'a2')).toMatchObject({ status: 'ok', ownership: 'unowned' });
    expect(await w.acq('oa', 'L', 'a2', { claim: false })).toMatchObject({ granted: true, ownership: 'unowned' });
    expect((await w.ownerRow('L'))!.owner_id).toBeNull();
    expect(await w.acq('oa', 'L', 'a1')).toMatchObject({ ownership: 'owner' });
    expect((await w.ownerRow('L'))!.owner_id).toBe(u('oa'));
  });

  it('O10: a fork the guest owns', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    await w.acq('oa', 'L1', 'a1');
    await w.acq('ob', 'L1', 'b1');
    await w.update('personal_vault_owners', { grace_started_at: w.ago(days(15)) }, [{ column: 'vault_key', op: 'eq', value: u('L1') }]);
    const [lo, hi] = [u('oa'), u('ob')].sort();
    await w.update('personal_vault_guest_grace', { started_at: w.ago(days(15)) }, [
      { column: 'account_lo', op: 'eq', value: lo },
      { column: 'account_hi', op: 'eq', value: hi },
    ]);
    expect(await w.acq('ob', 'L2', 'b1')).toMatchObject({ ownership: 'owner' });
    expect(await w.acq('oa', 'L2', 'a1')).toMatchObject({ granted: false, reason: 'not_owner' });
    expect(await w.sess('oa', 'L2', 'a1')).toBeNull();
    expect((await w.ownerRow('L2'))!.grace_started_at).toBeNull();
  });

  it('O11: claim false never writes an owner row', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    expect(await w.acq('oa', 'L', 'a1', { claim: false })).toMatchObject({ granted: true, ownership: 'unowned' });
    expect(await w.ownerRow('L')).toBeNull();
  });

  it('O12: refusals write no ownership state', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    await w.acq('oa', 'L', 'a1');
    for (let i = 1; i <= 5; i++) await w.live('ob', `W${i}`, `b${i}`, i * 60);
    const o = await w.ownerRow('L');
    expect(await w.acq('ob', 'L', 'b6')).toMatchObject({ reason: 'device_cap' });
    await w.setTier('ob', 'free');
    await w.live('ob', 'L', 'bx', 60);
    expect(await w.acq('ob', 'L', 'b6')).toMatchObject({ reason: 'vault_limit' });
    expect(await w.acq('ob', 'R', 'b7')).toMatchObject({ reason: 'device_cap' });
    expect(await w.ownerRow('L')).toEqual(o);
    expect(await w.rows('personal_vault_guest_grace')).toEqual([]);
    expect(await w.ownerRow('R')).toBeNull();
  });

  it('O9: parallel first opens agree on one owner', async () => {
    const w = await World.create();
    await w.mkUser('oa', 'pro');
    await w.mkUser('ob', 'pro');
    const [ra, rb] = await Promise.all([w.acq('oa', 'L', 'a1'), w.acq('ob', 'L', 'b1')]);
    const owners = [ra, rb].filter((r) => r.ownership === 'owner');
    expect(owners).toHaveLength(1);
    expect([ra, rb].filter((r) => r.ownership === 'grace')).toHaveLength(1);
    expect((await w.rows('personal_vault_owners')).length).toBe(1);
  });
});

describe('device cap', () => {
  it('D1, D2, D3, D5, D8', async () => {
    const w = await World.create();
    await w.mkUser('dp', 'pro');
    await w.live('dp', 'V1', 'd1', 50 * 60, { sessions: 2 });
    await w.live('dp', 'V2', 'd2', 40 * 60);
    await w.live('dp', 'V2b', 'd2', 45 * 60);
    for (let i = 3; i <= 5; i++) await w.live('dp', `V${i}`, `d${i}`, (40 - i * 5) * 60);

    const p = await w.peek('dp', 'V6', 'd6', 'macos', '0.18.0');
    expect(p).toMatchObject({ reason: 'device_cap', device_cap: 5 });
    expect(p.devices).toHaveLength(5);

    let r = await w.acq('dp', 'V6', 'd6');
    expect(r).toMatchObject({ granted: false, reason: 'device_cap', device_cap: 5 });
    const holders = r.holders as Record<string, unknown>[];
    expect(holders).toHaveLength(5);
    expect(holders[0]).toMatchObject({ device_id: u('d2'), vaults: 2 });
    expect(holders[4]!.device_id).toBe(u('d1'));
    expect(await w.sess('dp', 'V6', 'd6')).toBeNull();

    expect(await w.acq('dp', 'V1b', 'd1')).toMatchObject({ granted: true });

    r = await w.acq('dp', 'V6', 'd6', { takeover: true });
    expect(r.granted).toBe(true);
    const d2 = (await w.rows('personal_vault_sessions')).filter((s) => s.device_id === u('d2'));
    expect(d2.every((s) => s.status === 'displaced' && s.displaced_reason === 'device_cap' && s.displaced_by_device === u('d6'))).toBe(true);
    expect((await w.rows('personal_vault_sessions')).filter((s) => s.status === 'displaced')).toHaveLength(2);

    expect(await w.hb('dp', 'V2', 'd2')).toMatchObject({ status: 'displaced', reason: 'device_cap', by: 'dev-d6' });
  });

  it('D4: a lower cap applies at the next heartbeat', async () => {
    const w = await World.create();
    await w.mkUser('dp', 'pro');
    await w.live('dp', 'V1', 'd1', 50 * 60, { jobs: 1 });
    await w.live('dp', 'V2', 'd2', 10 * 60);
    await w.live('dp', 'V3', 'd3', 20 * 60);
    await w.live('dp', 'V4', 'd4', 30 * 60);
    expect((await w.acq('dp', 'V5', 'h')).granted).toBe(true);
    const pro = (await w.rows('tiers', [{ column: 'name', op: 'eq', value: 'pro' }]))[0]!;
    await w.update('tiers', { features: { ...(pro.features as object), account_max_active_devices: 2 } }, [{ column: 'name', op: 'eq', value: 'pro' }]);
    expect(await w.hb('dp', 'V5', 'h')).toMatchObject({ status: 'ok', device_cap: 2 });
    const active = (await w.rows('personal_vault_sessions')).filter((s) => s.status === 'active').map((s) => s.device_id).sort();
    expect(active).toEqual([u('d1'), u('h')].sort());
    const displaced = (await w.rows('personal_vault_sessions')).filter((s) => s.status === 'displaced');
    expect(displaced.every((s) => s.displaced_reason === 'device_cap')).toBe(true);
  });

  it('D6: Free takeover displaces only the holder', async () => {
    const w = await World.create();
    await w.mkUser('df');
    await w.live('df', 'V', 'd1', 60);
    for (let i = 2; i <= 5; i++) await w.live('df', `W${i}`, `d${i}`, 600 * i);
    const r = await w.acq('df', 'V', 'd6');
    expect(r).toMatchObject({ reason: 'vault_limit', also_locks: null, device_cap: 5 });
    expect(r.holders).toHaveLength(1);
    expect((await w.acq('df', 'V', 'd6', { takeover: true })).granted).toBe(true);
    const displaced = (await w.rows('personal_vault_sessions')).filter((s) => s.status === 'displaced').map((s) => s.device_id);
    expect(displaced).toEqual([u('d1')]);
    expect((await w.sess('df', 'V', 'd1'))!.displaced_reason).toBe('takeover');
  });

  it('D7: takeover also frees a device slot', async () => {
    const w = await World.create();
    await w.mkUser('df');
    await w.live('df', 'V', 'd1', 60);
    await w.live('df', 'W1', 'd1', 120);
    for (let i = 2; i <= 5; i++) await w.live('df', `W${i}`, `d${i}`, 600 * i);
    const r = await w.acq('df', 'V', 'd6');
    expect(r).toMatchObject({ reason: 'vault_limit', also_locks: { device_id: u('d5'), device_name: 'dev-d5' } });
    expect((await w.acq('df', 'V', 'd6', { takeover: true })).granted).toBe(true);
    expect((await w.sess('df', 'V', 'd1'))!.displaced_reason).toBe('takeover');
    expect((await w.sess('df', 'W1', 'd1'))!.status).toBe('active');
    expect((await w.sess('df', 'W5', 'd5'))!.displaced_reason).toBe('device_cap');
  });
});

describe('minimum app version', () => {
  it('V1: acquire and peek below the minimum', async () => {
    const w = await World.create();
    await w.mkUser('vu', 'pro');
    await w.setMin('0.19.0', '0.0.0');
    const r = await w.acq('vu', 'V', 'd1', { version: '0.18.2' });
    expect(r).toMatchObject({ granted: false, reason: 'update_required', min_version: '0.19.0', holders: [] });
    expect(await w.sess('vu', 'V', 'd1')).toBeNull();
    expect(await w.peek('vu', 'V', 'd1', 'macos', '0.18.2')).toMatchObject({ reason: 'update_required', min_version: '0.19.0' });
    expect(await w.peek('vu', 'V', 'd1')).not.toHaveProperty('reason');
    expect((await w.acq('vu', 'V', 'd1', { version: '0.19.0' })).granted).toBe(true);
  });

  it('V2: a heartbeat below a new minimum is displaced', async () => {
    const w = await World.create();
    await w.mkUser('vu', 'pro');
    expect((await w.acq('vu', 'V', 'd1', { version: '0.18.2' })).granted).toBe(true);
    await w.setMin('0.19.0', '0.0.0');
    expect(await w.hb('vu', 'V', 'd1')).toMatchObject({ status: 'displaced', reason: 'update_required', min_version: '0.19.0', by: null });
    expect((await w.sess('vu', 'V', 'd1'))!.displaced_reason).toBe('update_required');
    expect(await w.hb('vu', 'V', 'd1')).toMatchObject({ reason: 'update_required', min_version: '0.19.0' });
  });

  it('V3: unparseable versions', async () => {
    const w = await World.create();
    await w.mkUser('vu', 'pro');
    await w.setMin('0.19.0', '0.0.0');
    expect(await w.acq('vu', 'V', 'd1', { version: 'abc' })).toMatchObject({ reason: 'update_required' });
    await w.setMin('0.0.0', '0.0.0');
    expect((await w.acq('vu', 'V', 'd1', { version: 'abc' })).granted).toBe(true);
  });

  it('V5: platform groups', async () => {
    const w = await World.create();
    await w.mkUser('vu', 'pro');
    await w.setMin('0.0.0', '1.2.0');
    expect(await w.acq('vu', 'V', 'd1', { platform: 'x', version: '9.9.9' })).toMatchObject({ reason: 'update_required' });
    expect(await w.acq('vu', 'V', 'd1', { platform: null, version: '9.9.9' })).toMatchObject({ reason: 'update_required' });
    expect((await w.acq('vu', 'V', 'd1', { version: '0.1.0' })).granted).toBe(true);
    expect(await w.acq('vu', 'V', 'd2', { platform: 'ipados', version: '1.1.9' })).toMatchObject({ reason: 'update_required', min_version: '1.2.0' });
    await w.setMin('0.0.0', '0.0.0');
    const e = await w.err('vu', {
      kind: 'rpc', fn: 'vault_session_acquire',
      args: { p_vault_key: u('V'), p_device_id: u('d3'), p_session_nonce: crypto.randomUUID(), p_device_name: 'dev', p_platform: 'x', p_app_version: '1.0.0' },
    });
    expect(e.startsWith('23514')).toBe(true);
  });
});

describe('cloud backup', () => {
  const up = (path: string, upsert = false) => ({ kind: 'storage' as const, action: 'upload' as const, bucket: 'vaults', path, body: Buffer.from('x').toString('base64'), upsert });
  const seed = (w: World, user: string, path: string) => w.ok('service', up(`${u(user)}/${path}`));

  it('C1: Free cannot write backups', async () => {
    const w = await World.create();
    await w.mkUser('cf');
    const v = u('vault-1');
    await seed(w, 'cf', `${v}/vault.enc`);
    expect(await w.err('cf', up(`${u('cf')}/${u('vault-2')}/vault.enc`))).toMatch(/^403/);
    expect(await w.err('cf', up(`${u('cf')}/${v}/vault.enc`, true))).toMatch(/^403/);
  });

  it('C2: team members can', async () => {
    const w = await World.create();
    await w.mkUser('ct');
    await w.update('user_profiles', { is_team_member: true }, [{ column: 'id', op: 'eq', value: u('ct') }]);
    await w.ok('ct', up(`${u('ct')}/${u('vault-1')}/vault.enc`));
  });

  it('C3, C7: snapshot cap per vault, overwrite allowed', async () => {
    const w = await World.create();
    await w.mkUser('cp', 'pro');
    const v1 = u('vault-1');
    await seed(w, 'cp', `${v1}/vault.enc`);
    for (let i = 1; i <= 25; i++) await seed(w, 'cp', `${v1}/backups/vault_2026-09-${String(i).padStart(2, '0')}_10-00-00-000_aaaaaa.enc`);
    expect(await w.err('cp', up(`${u('cp')}/${v1}/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc`))).toMatch(/^403/);
    await w.ok('cp', up(`${u('cp')}/${u('vault-2')}/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc`));
    await w.ok('cp', up(`${u('cp')}/${v1}/backups/vault_2026-09-03_10-00-00-000_aaaaaa.enc`, true));
  });

  it('C4: Free can read and delete what it has', async () => {
    const w = await World.create();
    await w.mkUser('cf');
    await seed(w, 'cf', 'vault.enc');
    await seed(w, 'cf', 'backups/vault_2026-02-17_21-36-10.enc');
    const top = (await w.ok('cf', { kind: 'storage', action: 'list', bucket: 'vaults', path: u('cf') })) as { name: string }[];
    expect(top.map((e) => e.name).sort()).toEqual(['backups', 'vault.enc']);
    const removed = (await w.ok('cf', {
      kind: 'storage', action: 'remove', bucket: 'vaults', paths: [`${u('cf')}/vault.enc`, `${u('cf')}/backups/vault_2026-02-17_21-36-10.enc`],
    })) as unknown[];
    expect(removed).toHaveLength(2);
    const dl = await w.call('cf', { kind: 'storage', action: 'download', bucket: 'vaults', path: `${u('cf')}/vault.enc` });
    expect(dl.status).toBe(404);
  });

  it('C5: allowed names only', async () => {
    const w = await World.create();
    await w.mkUser('cp', 'pro');
    const v = u('vault-1');
    const me = u('cp');
    for (const bad of [`${me}/${v}/x.bin`, `${me}/${v}/backups/a/b.enc`, `${me}/other.enc`, `${u('someone')}/vault.enc`]) {
      expect(await w.err('cp', up(bad))).toMatch(/^403/);
    }
    for (const good of [`${me}/${v}/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc`, `${me}/backups/vault_2026-02-17_21-36-10.enc`, `${me}/manifest.json`, `${me}/vault.enc`]) {
      await w.ok('cp', up(good));
    }
  });

  it('C6: vault cap', async () => {
    const w = await World.create();
    await w.mkUser('cp', 'pro');
    for (let i = 1; i <= 10; i++) await seed(w, 'cp', `${u(`vault-${i}`)}/vault.enc`);
    expect(await w.err('cp', up(`${u('cp')}/${u('vault-11')}/vault.enc`))).toMatch(/^403/);
    await w.ok('cp', up(`${u('cp')}/${u('vault-3')}/backups/vault_2026-09-26_14-03-07-412_a1b2c3.enc`));
  });

  it('round trip and duplicate refusal', async () => {
    const w = await World.create();
    await w.mkUser('cp', 'pro');
    const path = `${u('cp')}/manifest.json`;
    await w.ok('cp', { kind: 'storage', action: 'upload', bucket: 'vaults', path, body: Buffer.from('{"a":1}').toString('base64') });
    expect(await w.err('cp', { kind: 'storage', action: 'upload', bucket: 'vaults', path, body: 'AA==' })).toMatch(/^409/);
    const dl = (await w.ok('cp', { kind: 'storage', action: 'download', bucket: 'vaults', path })) as { body: string };
    expect(Buffer.from(dl.body, 'base64').toString()).toBe('{"a":1}');
    expect(await w.call('ob', { kind: 'storage', action: 'download', bucket: 'vaults', path })).toMatchObject({ status: 404 });
  });
});

describe('files too big for a request body', () => {
  it('upload from the staging bucket only by its creator; download hands back a file ID the owner may read', async () => {
    const w = await World.create();
    await w.mkUser('big', 'pro');
    await w.mkUser('thief', 'pro');
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    w.files.blobs.set('uploads/stage1', big);
    w.files.stagedOwners.set('stage1', u('big'));
    const path = `${u('big')}/vault.enc`;
    expect(await w.err('thief', { kind: 'storage', action: 'upload', bucket: 'vaults', path: `${u('thief')}/vault.enc`, staged: 'stage1' })).toMatch(/^404/);
    await w.ok('big', { kind: 'storage', action: 'upload', bucket: 'vaults', path, staged: 'stage1' });
    expect(w.files.blobs.has('uploads/stage1')).toBe(false);
    const dl = (await w.ok('big', { kind: 'storage', action: 'download', bucket: 'vaults', path })) as { body?: string; bucket: string; fileId: string };
    expect(dl.body).toBeUndefined();
    expect(w.files.blobs.get(`${dl.bucket}/${dl.fileId}`)?.equals(big)).toBe(true);
    expect(w.files.readers.get(`vaults/${dl.fileId}`)).toEqual(new Set([u('big')]));
  });

  it('refuses more than 10 MB', async () => {
    const w = await World.create();
    await w.mkUser('huge', 'pro');
    w.files.blobs.set('uploads/stage2', Buffer.alloc(10 * 1024 * 1024 + 1));
    w.files.stagedOwners.set('stage2', u('huge'));
    expect(await w.err('huge', { kind: 'storage', action: 'upload', bucket: 'vaults', path: `${u('huge')}/vault.enc`, staged: 'stage2' })).toMatch(/^413/);
  });
});

describe('file bytes follow their rows', () => {
  it('replacing, removing, and deleting the owner release the old bytes', async () => {
    const w = await World.create();
    await w.mkUser('fb', 'pro');
    const path = `${u('fb')}/manifest.json`;
    const up = (body: string) => w.ok('fb', { kind: 'storage', action: 'upload', bucket: 'vaults', path, body: Buffer.from(body).toString('base64'), upsert: true });
    await up('one');
    await up('two');
    expect(w.files.blobs.size).toBe(1);
    await w.ok('fb', { kind: 'storage', action: 'upload', bucket: 'vaults', path: `${u('fb')}/vault.enc`, body: 'AA==' });
    await w.ok('fb', { kind: 'storage', action: 'remove', bucket: 'vaults', paths: [`${u('fb')}/vault.enc`] });
    expect(w.files.blobs.size).toBe(1);
    const { userDeleted } = await import('../../src/api/jobs.ts');
    w.users.delete(u('fb'));
    await userDeleted({ store: w.store, files: w.files, directory: w.directory, effects: w.fx, now: () => w.clock }, u('fb'));
    expect(w.files.blobs.size).toBe(0);
  });
});
