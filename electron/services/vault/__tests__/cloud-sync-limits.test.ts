// @vitest-environment node
// Cloud backup under the server's plan caps (docs/PLAN_ENFORCEMENT.md 2.9, 4.10; test D13): the
// count prune before each snapshot, the age prune even when the snapshot fails, and how a
// policy refusal reads (S16 plan, S17 snapshot cap, S24 vault-folder cap).
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));
vi.mock('../../../ipc/settings.js', () => ({ readSettings: () => ({}) }));

const { CloudSyncService } = await import('../cloud-sync.js');
const limits = await import('../cloud-backup-limits.js');

const RLS = { message: 'new row violates row-level security policy', statusCode: '403' };

interface Server {
  on: boolean;
  features: Record<string, unknown>;
  teamMember?: boolean;
  refuse: (path: string) => boolean;
  backups: { name: string; created_at: string }[];
  folderEmpty: boolean;
}

function fakeAuth(server: Server) {
  const upload = vi.fn(async (path: string) => ({ error: server.refuse(path) ? RLS : null }));
  const remove = vi.fn(async (_paths: string[]) => ({ error: null }));
  const list = vi.fn(async (prefix: string) => {
    if (prefix.endsWith('/backups')) return { data: server.backups, error: null };
    if (prefix === 'u1/v1') return { data: server.folderEmpty ? [] : [{ name: 'vault.enc' }], error: null };
    return { data: [], error: null };
  });
  const bucket = { upload, remove, list, download: vi.fn(async () => ({ data: null, error: { message: 'not found' } })) };
  const profile = () => ({ id: 'u1', is_team_member: server.teamMember ?? false, tier: { features: { cloud_sync_enabled: server.on, ...server.features } } });
  const auth = {
    getAuthState: () => ({ user: { id: 'u1' }, profile: profile() }),
    reloadProfile: vi.fn(async () => profile()),
    getSupabaseClient: () => ({ storage: { from: () => bucket } }),
  };
  return { auth, upload, remove };
}

function service(server: Server) {
  const fake = fakeAuth(server);
  const s = new CloudSyncService(fake.auth as never);
  s.configure({ userId: 'u1', vaultId: 'v1', masterPassword: 'pw', vaultPath: '/x.conduit', enabled: true, snapshot: async (t: string) => fs.writeFileSync(t, 'w') });
  return { s, ...fake };
}

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T10:00:00.000Z`;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('countPruneTargets', () => {
  it('keeps the newest cap - 1 and never prunes an unknown or unlimited cap', () => {
    const backups = [1, 2, 3, 4].map((d) => ({ path: `p${d}`, created_at: day(d) }));
    expect(limits.countPruneTargets(backups, 3)).toEqual(['p2', 'p1']);
    expect(limits.countPruneTargets(backups, 25)).toEqual([]);
    expect(limits.countPruneTargets(backups, -1)).toEqual([]);
    expect(limits.countPruneTargets(backups, null)).toEqual([]);
  });

  it('recognises a policy refusal', () => {
    expect(limits.isPolicyRefusal(RLS)).toBe(true);
    expect(limits.isPolicyRefusal({ status: 403 })).toBe(true);
    expect(limits.isPolicyRefusal({ message: 'Payload too large', statusCode: '413' })).toBe(false);
    expect(limits.isPolicyRefusal(null)).toBe(false);
  });
});

describe('CloudSyncService under the plan caps', () => {
  it('prunes by count before the snapshot so at most max_cloud_backups remain', async () => {
    const backups = [1, 2, 3].map((d) => ({ name: `vault_${d}.enc`, created_at: day(d) }));
    const { s, remove, upload } = service({ on: true, features: { max_cloud_backups: 3 }, refuse: () => false, backups, folderEmpty: false });
    await s.syncNow();
    await vi.waitFor(() => expect(upload.mock.calls.some((c) => String(c[0]).includes('/backups/'))).toBe(true));
    expect(remove.mock.calls[0]?.[0]).toEqual(['u1/v1/backups/vault_1.enc']);
  });

  it('S17: a refused snapshot keeps vault.enc and still runs the age prune', async () => {
    const backups = [{ name: 'vault_old.enc', created_at: '2020-01-01T00:00:00.000Z' }];
    const { s, remove } = service({
      on: true,
      features: { max_cloud_backups: 25, backup_retention_days: 30 },
      refuse: (p) => p.includes('/backups/'),
      backups,
      folderEmpty: false,
    });
    await s.syncNow();
    await vi.waitFor(() => expect(s.getState().notice).toEqual({ kind: 'full' }));
    expect(s.getState().status).toBe('synced');
    await vi.waitFor(() => expect(remove.mock.calls.some((c) => (c[0] as string[]).includes('u1/v1/backups/vault_old.enc'))).toBe(true));
    expect(limits.noticeMessage({ kind: 'full' })).toBe('Cloud backup is full. Conduit removes the oldest backup before the next one.');
  });

  it('S16: vault.enc refused and the plan now says no stops backup with the plan notice', async () => {
    const server: Server = { on: true, features: {}, refuse: (p) => p.endsWith('/vault.enc'), backups: [], folderEmpty: false };
    const { s } = service(server);
    server.on = false;
    await expect(s.syncNow()).rejects.toThrow();
    expect(s.getState()).toMatchObject({ enabled: false, notice: { kind: 'plan' } });
  });

  it('S16: vault.enc refused while the cached plan still says yes: the server is the truth', async () => {
    const { s } = service({ on: true, features: {}, refuse: (p) => p.endsWith('/vault.enc'), backups: [], folderEmpty: false });
    await s.syncNow();
    expect(s.getState()).toMatchObject({
      status: 'error',
      error: 'Cloud backup needs Pro or Team. Your earlier backups are still here.',
      notice: { kind: 'plan' },
    });
  });

  it('S24: vault.enc refused for a new vault folder is the vault-folder cap', async () => {
    const { s } = service({ on: true, features: { max_cloud_backup_vaults: 10 }, refuse: (p) => p.endsWith('/vault.enc'), backups: [], folderEmpty: true });
    await s.syncNow();
    expect(s.getState()).toMatchObject({
      status: 'error',
      notice: { kind: 'vaults-full', vaults: 10 },
      error: "Cloud backup is full: your plan backs up 10 vaults. Remove an old vault's backups to back up this one.",
    });
  });

  it('a team member may back up on a tier without cloud_sync_enabled', async () => {
    const { s, upload } = service({ on: false, teamMember: true, features: {}, refuse: () => false, backups: [], folderEmpty: false });
    await s.syncNow();
    expect(upload).toHaveBeenCalled();
  });
});
