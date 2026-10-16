import { randomBytes, randomUUID } from 'node:crypto';
import { Client, Storage, Users } from 'node-appwrite';
import { Client as WebClient, Query, Realtime } from 'appwrite';
import { afterAll, describe, expect, it } from 'vitest';
import { ConduitDb } from '../../src/client/index.ts';
import { functionTransport } from '../../src/client/appwrite-transport.ts';
import { adminClient, cleanupUsers, ENV, makeUser, service } from './env.ts';

afterAll(cleanupUsers);

describe('live api', () => {
  it('a new user gets a Free profile and reads it with the tier joined', async () => {
    const a = await makeUser('basic');
    const { data, error } = await a.db
      .from('user_profiles')
      .select('id, display_name, tier_id, is_team_member, subscription_status, tier:tiers ( name, display_name, features )')
      .eq('id', a.id)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: a.id, display_name: 'basic', is_team_member: false, subscription_status: 'none', tier: { name: 'free' } });
    expect((data.tier.features as Record<string, unknown>).vault_max_open_devices).toBe(1);
  });

  it('row rules hold through the function', async () => {
    const a = await makeUser('rules-a');
    const b = await makeUser('rules-b');
    const { data: others } = await a.db.from('user_profiles').select('*').eq('id', b.id);
    expect(others).toEqual([]);
    const { error } = await a.db.from('user_profiles').update({ tier_id: null }).eq('id', a.id);
    expect(error).toMatchObject({ code: '42501', message: 'protected column' });
    const { data: renamed } = await a.db.from('user_profiles').update({ display_name: 'Renamed' }).eq('id', a.id).select('display_name');
    expect(renamed).toEqual([{ display_name: 'Renamed' }]);
  });

  it('an anonymous caller cannot run the function; a wrong service secret is anonymous', async () => {
    const anon = new ConduitDb(functionTransport(new Client().setEndpoint(ENV.APPWRITE_ENDPOINT!).setProject(ENV.APPWRITE_PROJECT_ID!)));
    const r = await anon.from('tiers').select('*');
    expect(r.error).not.toBeNull();
    const fake = new ConduitDb(functionTransport(adminClient(), { serviceSecret: 'nope' }));
    const t = await fake.from('tiers').select('*');
    expect(t.data).toEqual([]);
  });

  it('parallel first opens of a vault agree on one owner (O9 on real Appwrite)', async () => {
    const a = await makeUser('o9-a', 'pro');
    const b = await makeUser('o9-b', 'pro');
    const vault = randomUUID();
    const acquire = (u: typeof a) =>
      u.db.rpc('vault_session_acquire', {
        p_vault_key: vault, p_device_id: randomUUID(), p_session_nonce: randomUUID(), p_device_name: 'dev', p_platform: 'macos',
        p_app_version: '0.19.0', p_file_name: 'v.conduit', p_file_id: null, p_location: null,
      });
    const results = await Promise.all([acquire(a), acquire(b), acquire(a), acquire(b)]);
    for (const r of results) expect(r.error).toBeNull();
    const owners = new Set(results.filter((r) => r.data.ownership === 'owner').map((r) => r.data.lease_id && r));
    expect(results.every((r) => r.data.granted === true)).toBe(true);
    const { data: rows } = await service().from('personal_vault_owners').select('*').eq('vault_key', vault);
    expect(rows).toHaveLength(1);
    expect(owners.size).toBeGreaterThan(0);
  });

  it('parallel seat claims never pass the seat count (T4 on real Appwrite)', async () => {
    const owner = await makeUser('t4-owner', 'team');
    const members = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser(`t4-m${i}`)));
    const svc = service();
    const teamId = randomUUID();
    const { error: teamError } = await svc.from('teams').insert({ id: teamId, name: 'T4', slug: `t4-${teamId.slice(0, 8)}`, owner_id: owner.id, max_seats: 2, stripe_subscription_id: 'sub_live' });
    expect(teamError).toBeNull();
    const results = await Promise.all(members.map((m) => svc.from('team_members').insert({ team_id: teamId, user_id: m.id })));
    expect(results.filter((r) => r.error === null)).toHaveLength(2);
    expect(results.filter((r) => r.error?.message.startsWith('team_full'))).toHaveLength(4);
    const { count } = await svc.from('team_members').select('id', { count: 'exact', head: true }).eq('team_id', teamId);
    expect(count).toBe(2);
  });

  it('parallel duplicate inserts on a unique pair: one wins, the rest get 23505', async () => {
    const owner = await makeUser('uq-owner', 'team');
    const member = await makeUser('uq-member', 'team');
    const svc = service();
    const teamId = randomUUID();
    const vaultId = randomUUID();
    await svc.from('teams').insert({ id: teamId, name: 'UQ', slug: `uq-${teamId.slice(0, 8)}`, owner_id: owner.id, stripe_subscription_id: 'sub_live' });
    await svc.from('team_members').insert([{ team_id: teamId, user_id: owner.id, role: 'admin' }, { team_id: teamId, user_id: member.id }]);
    await svc.from('team_vaults').insert({ id: vaultId, team_id: teamId, name: 'UQ', created_by: owner.id });
    const res = await Promise.all(Array.from({ length: 4 }, () => svc.from('team_vault_members').insert({ team_vault_id: vaultId, user_id: member.id, role: 'viewer' })));
    expect(res.filter((r) => r.error === null)).toHaveLength(1);
    expect(res.filter((r) => r.error?.code === '23505')).toHaveLength(3);
  });

  it('storage round trip through the function', async () => {
    const a = await makeUser('files', 'pro');
    const bucket = a.db.storage.from('vaults');
    const path = `${a.id}/manifest.json`;
    expect((await bucket.upload(path, '{"v":1}', { upsert: true, contentType: 'application/json' })).error).toBeNull();
    expect((await bucket.upload(path, '{"v":2}', { upsert: true })).error).toBeNull();
    const { data } = await bucket.download(path);
    expect(await data!.text()).toBe('{"v":2}');
    const { data: listing } = await bucket.list(a.id);
    expect(listing!.map((f) => f.name)).toEqual(['manifest.json']);
    const other = await makeUser('files-b', 'pro');
    expect((await other.db.storage.from('vaults').download(path)).error).not.toBeNull();
    expect((await bucket.remove([path])).data).toHaveLength(1);
  });

  it('a 9 MB backup goes through the staging bucket and comes back byte for byte', async () => {
    const a = await makeUser('bigfile', 'pro');
    const bucket = a.db.storage.from('vaults');
    const path = `${a.id}/vault.enc`;
    const bytes = randomBytes(9 * 1024 * 1024);
    const up = await bucket.upload(path, bytes, { upsert: true });
    expect(up.error).toBeNull();
    const { data, error } = await bucket.download(path);
    expect(error).toBeNull();
    expect(Buffer.from(await data!.arrayBuffer()).equals(bytes)).toBe(true);
    const other = await makeUser('bigfile-b', 'pro');
    expect((await other.db.storage.from('vaults').download(path)).error).not.toBeNull();
    const { files } = await new Storage(adminClient()).listFiles({ bucketId: 'uploads' });
    expect(files.filter((f) => f.$permissions.some((p) => p.includes(a.id)))).toEqual([]);
  });

  it('team vault changes reach members over Realtime, and only members', async () => {
    const admin = await makeUser('rt-admin', 'team');
    const member = await makeUser('rt-member', 'team');
    const outsider = await makeUser('rt-out', 'team');
    const svc = service();
    const teamId = randomUUID();
    const vaultId = randomUUID();
    await svc.from('teams').insert({ id: teamId, name: 'RT', slug: `rt-${teamId.slice(0, 8)}`, owner_id: admin.id, stripe_subscription_id: 'sub_live' });
    for (const [u, role] of [[admin, 'admin'], [member, 'member'], [outsider, 'member']] as const) {
      expect((await svc.from('team_members').insert({ team_id: teamId, user_id: u.id, role })).error).toBeNull();
    }
    expect((await admin.db.from('team_vaults').insert({ id: vaultId, team_id: teamId, name: 'Live', created_by: admin.id })).error).toBeNull();
    expect((await admin.db.from('team_vault_members').insert({ team_vault_id: vaultId, user_id: admin.id, role: 'admin' })).error).toBeNull();
    expect((await admin.db.from('team_vault_members').insert({ team_vault_id: vaultId, user_id: member.id, role: 'editor' })).error).toBeNull();

    const listen = (u: typeof admin) => {
      (globalThis as unknown as { window?: unknown }).window ??= globalThis;
      const events: Record<string, unknown>[] = [];
      const rt = new Realtime(new WebClient().setEndpoint(ENV.APPWRITE_ENDPOINT!).setProject(ENV.APPWRITE_PROJECT_ID!).setSession(u.session));
      const sub = rt.subscribe('tablesdb.conduit.tables.vault_entries.rows', (e) => events.push(e.payload as Record<string, unknown>), [Query.equal('vault_id', [vaultId])]);
      return { events, sub };
    };
    const m = listen(member);
    const o = listen(outsider);
    await Promise.all([m.sub, o.sub]);
    await new Promise((r) => setTimeout(r, 1500));

    const entryId = randomUUID();
    const up = await member.db.rpc('upsert_vault_entry_versioned', { p_id: entryId, p_vault_id: vaultId, p_name: 'db', p_entry_type: 'ssh', p_host: '10.0.0.1' });
    expect(up.data).toEqual([{ success: true, current_version: 1 }]);
    for (let i = 0; i < 40 && m.events.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1000));
    expect(m.events.some((e) => e.host === '10.0.0.1')).toBe(true);
    expect(o.events).toEqual([]);
    for (const s of [m, o]) await (await s.sub).close();
  });

  it('deleting a user replays the old cascade', async () => {
    const a = await makeUser('gone', 'pro');
    const vault = randomUUID();
    await a.db.rpc('vault_session_acquire', {
      p_vault_key: vault, p_device_id: randomUUID(), p_session_nonce: randomUUID(), p_device_name: 'dev', p_platform: 'macos', p_app_version: '0.19.0',
    });
    await new Users(adminClient()).delete({ userId: a.id });
    const svc = service();
    for (let i = 0; i < 60; i++) {
      const { data } = await svc.from('user_profiles').select('id').eq('id', a.id);
      if (data?.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await svc.from('user_profiles').select('id').eq('id', a.id)).data).toEqual([]);
    expect((await svc.from('personal_vault_sessions').select('*').eq('user_id', a.id)).data).toEqual([]);
    expect((await svc.from('personal_vault_owners').select('*').eq('vault_key', vault)).data).toMatchObject([{ owner_id: null, owner_since: null }]);
  });
});
