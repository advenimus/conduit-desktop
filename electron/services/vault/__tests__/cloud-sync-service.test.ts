// @vitest-environment node
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));
vi.mock('../../../ipc/settings.js', () => ({ readSettings: () => ({}) }));

const { CloudSyncService } = await import('../cloud-sync.js');
const { CLOUD_BLOB_V1, decryptFromCloud } = await import('../cloud-crypto.js');
const { CLOUD_BACKUP_PLAN_MESSAGE } = await import('../cloud-backup-plan.js');

const PASSWORD = 'pw';

const profileWith = (on: boolean) => ({ id: 'u1', tier: { features: { cloud_sync_enabled: on } } });

/**
 * `server.on` is the plan in Supabase. Like AuthService, getAuthState answers the profile read at
 * sign-in; only reloadProfile reads the plan again.
 */
function fakeAuth(server: { on: boolean }) {
  const upload = vi.fn<(storagePath: string, blob: Buffer) => Promise<{ error: null }>>(async () => ({ error: null }));
  const bucket = {
    upload,
    download: vi.fn(async () => ({ data: null, error: { message: 'not found' } })),
    list: vi.fn(async () => ({ data: [], error: null })),
    remove: vi.fn(async () => ({ error: null })),
  };
  let profile = profileWith(server.on);
  const auth = {
    getAuthState: () => ({ user: { id: 'u1' }, profile }),
    reloadProfile: vi.fn(async () => {
      profile = profileWith(server.on);
      return profile;
    }),
    getSupabaseClient: () => ({ storage: { from: () => bucket } }),
  };
  return { auth, upload };
}

function configure(service: InstanceType<typeof CloudSyncService>, snapshot?: (t: string) => Promise<void>) {
  service.configure({ userId: 'u1', vaultId: 'v1', masterPassword: PASSWORD, vaultPath: '/nonexistent/shared.conduit', enabled: true, snapshot });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('CloudSyncService', () => {
  it('stays off at unlock when the plan has no cloud backup', () => {
    const { auth } = fakeAuth({ on: false });
    const service = new CloudSyncService(auth as never);
    configure(service);
    expect(service.getState()).toMatchObject({ enabled: false, status: 'disabled', error: CLOUD_BACKUP_PLAN_MESSAGE });
  });

  it('uploads a snapshot of the working copy, not the shared file', async () => {
    const { auth, upload } = fakeAuth({ on: true });
    const service = new CloudSyncService(auth as never);
    const snapshot = vi.fn(async (target: string) => fs.writeFileSync(target, 'working copy'));
    configure(service, snapshot);
    await service.syncNow();
    expect(snapshot).toHaveBeenCalledTimes(1);
    const blob = upload.mock.calls[0][1];
    expect(blob[0]).toBe(CLOUD_BLOB_V1);
    expect(decryptFromCloud(blob, PASSWORD).toString()).toBe('working copy');
    expect(service.getState().status).toBe('synced');
  });

  it('two uploads in the same second keep two backup snapshots (no name collision)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-26T14:03:07.250Z'));
      const { auth, upload } = fakeAuth({ on: true });
      const service = new CloudSyncService(auth as never);
      configure(service, async (t) => fs.writeFileSync(t, 'x'));
      await service.syncNow();
      await service.syncNow();
      const snapshots = () => upload.mock.calls.map((c) => c[0]).filter((p) => p.startsWith('u1/v1/backups/'));
      await vi.waitFor(() => expect(snapshots()).toHaveLength(2));
      expect(new Set(snapshots()).size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops uploading after a downgrade the profile read at sign-in does not show', async () => {
    const plan = { on: true };
    const { auth, upload } = fakeAuth(plan);
    const service = new CloudSyncService(auth as never);
    configure(service, async (t) => fs.writeFileSync(t, 'x'));
    plan.on = false;
    await expect(service.syncNow()).rejects.toThrow(CLOUD_BACKUP_PLAN_MESSAGE);
    expect(upload).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ enabled: false, error: CLOUD_BACKUP_PLAN_MESSAGE });
  });

  it('re-reads the plan before an upload after an edit', async () => {
    vi.useFakeTimers();
    try {
      const plan = { on: true };
      const { auth, upload } = fakeAuth(plan);
      const service = new CloudSyncService(auth as never);
      configure(service, async (t) => fs.writeFileSync(t, 'x'));
      plan.on = false;
      service.notifyMutation();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(auth.reloadProfile).toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(service.getState()).toMatchObject({ enabled: false, error: CLOUD_BACKUP_PLAN_MESSAGE });
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns itself off after an unlock when the plan changed since sign-in', async () => {
    const plan = { on: true };
    const { auth, upload } = fakeAuth(plan);
    const service = new CloudSyncService(auth as never);
    plan.on = false;
    configure(service, async (t) => fs.writeFileSync(t, 'x'));
    await vi.waitFor(() => expect(service.getState()).toMatchObject({ enabled: false, status: 'disabled', error: CLOUD_BACKUP_PLAN_MESSAGE }));
    service.notifyMutation();
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps uploading when the plan read fails (offline): the cached plan decides', async () => {
    const { auth, upload } = fakeAuth({ on: true });
    auth.reloadProfile.mockRejectedValue(new Error('fetch failed'));
    const service = new CloudSyncService(auth as never);
    configure(service, async (t) => fs.writeFileSync(t, 'x'));
    await service.syncNow();
    expect(upload.mock.calls[0][0]).toBe('u1/v1/vault.enc');
    expect(service.getState()).toMatchObject({ enabled: true, status: 'synced' });
  });

  it('uploads nothing when the vault locks while the backup is being read', async () => {
    const { auth, upload } = fakeAuth({ on: true });
    const service = new CloudSyncService(auth as never);
    configure(service, async (t) => {
      service.disable();
      fs.writeFileSync(t, 'x');
    });
    await service.syncNow();
    expect(upload).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ enabled: false, status: 'disabled', error: null });
  });

  it('never encrypts with a password that was replaced while the backup was being read', async () => {
    const { auth, upload } = fakeAuth({ on: true });
    const service = new CloudSyncService(auth as never);
    configure(service, async (t) => {
      service.configure({ userId: 'u1', vaultId: 'v1', masterPassword: 'new-pw', vaultPath: '/nonexistent/shared.conduit', enabled: true });
      fs.writeFileSync(t, 'x');
    });
    await service.syncNow();
    for (const [, blob] of upload.mock.calls) {
      expect(() => decryptFromCloud(blob, 'new-pw')).not.toThrow();
    }
  });
});
