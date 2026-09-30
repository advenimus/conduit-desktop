// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

vi.mock('../../services/sync/app-sync-actions.js', () => ({ restoreFromBackup: vi.fn() }));

const actions = await import('../../services/sync/app-sync-actions.js');
const { parseRestoreRequest, restoreBackup, RESTORE_NEEDS_SYNC_MESSAGE, RESTORE_OPEN_VAULT_FIRST_MESSAGE } = await import('../backup-restore.js');

const VAULT_PATH = path.resolve('/tmp/vaults/Work.conduit');
const BYTES = Buffer.from('decrypted backup');
let tmpRoot: string;

function host(engine: boolean, syncs = false) {
  return {
    engineVaultFor: vi.fn(() => (engine ? ({ engine: {}, replica: {} } as never) : null)),
    syncsWhenOpened: vi.fn(async () => syncs),
    replaceAndOpen: vi.fn(async () => {}),
    tmpRoot,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  silenceConsole();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-restore-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('restore request', () => {
  it('needs a password and a .conduit target for a new vault', () => {
    expect(() => parseRestoreRequest({})).toThrow('Invalid sync request: password');
    expect(() => parseRestoreRequest({ masterPassword: 'pw', mode: 'new-vault' })).toThrow('Invalid sync request: target path');
    expect(() => parseRestoreRequest({ masterPassword: 'pw', mode: 'overwrite' })).toThrow('Invalid sync request: restore mode');
    expect(parseRestoreRequest({ masterPassword: 'pw', backupPassword: 'old' })).toEqual({
      masterPassword: 'pw',
      backupPassword: 'old',
      mode: null,
      targetPath: null,
    });
  });
});

describe('restore routing (spec 5.10)', () => {
  it('previews through the engine by default and removes the staged file', async () => {
    let staged = '';
    vi.mocked(actions.restoreFromBackup).mockImplementation(async (_v, file) => {
      staged = file;
      expect(fs.readFileSync(file).equals(BYTES)).toBe(true);
      return { mode: 'preview', preview: { deletions: [], restorations: [], replacements: [], unreadableSecrets: 0 } };
    });
    const h = host(true);
    const request = parseRestoreRequest({ masterPassword: 'pw', backupPassword: 'old' });
    const res = await restoreBackup(h, { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'local_backup_restore' });
    expect(res.mode).toBe('preview');
    expect(actions.restoreFromBackup).toHaveBeenCalledWith(expect.anything(), staged, 'old', 'preview', null);
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
    expect(h.replaceAndOpen).not.toHaveBeenCalled();
  });

  it('passes rollback and new-vault choices to the engine', async () => {
    vi.mocked(actions.restoreFromBackup).mockResolvedValue({ mode: 'rollback', applied: 3 });
    const target = path.resolve('/tmp/vaults/Work restored.conduit');
    const request = parseRestoreRequest({ masterPassword: 'pw', mode: 'new-vault', targetPath: target });
    await restoreBackup(host(true), { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'cloud_backup_restore' });
    expect(actions.restoreFromBackup).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'pw', 'new-vault', target);
  });

  it('replaces the whole file when the engine does not run that vault', async () => {
    const h = host(false);
    const request = parseRestoreRequest({ masterPassword: 'pw' });
    const res = await restoreBackup(h, { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'cloud_vault_restore' });
    expect(res).toEqual({ mode: 'replaced', path: VAULT_PATH });
    expect(h.replaceAndOpen).toHaveBeenCalledWith({ bytes: BYTES, vaultPath: VAULT_PATH, password: 'pw', source: 'cloud_vault_restore' });
    expect(actions.restoreFromBackup).not.toHaveBeenCalled();
  });

  it('refuses to replace the file of a synced vault that is not open (the merge would undo it)', async () => {
    const h = host(false, true);
    for (const mode of [null, 'rollback'] as const) {
      const request = parseRestoreRequest({ masterPassword: 'pw', mode });
      await expect(restoreBackup(h, { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'cloud_backup_restore' })).rejects.toThrow(
        RESTORE_OPEN_VAULT_FIRST_MESSAGE,
      );
    }
    expect(h.syncsWhenOpened).toHaveBeenCalledWith(VAULT_PATH);
    expect(h.replaceAndOpen).not.toHaveBeenCalled();
    expect(actions.restoreFromBackup).not.toHaveBeenCalled();
  });

  it('never replaces the file when a rollback or new vault was asked for', async () => {
    const h = host(false);
    const request = parseRestoreRequest({ masterPassword: 'pw', mode: 'rollback' });
    await expect(restoreBackup(h, { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'local_backup_restore' })).rejects.toThrow(
      RESTORE_NEEDS_SYNC_MESSAGE,
    );
    expect(h.replaceAndOpen).not.toHaveBeenCalled();
  });

  it('removes the staged file when the engine restore fails', async () => {
    let staged = '';
    vi.mocked(actions.restoreFromBackup).mockImplementation(async (_v, file) => {
      staged = file;
      throw new Error('Invalid master password');
    });
    const request = parseRestoreRequest({ masterPassword: 'pw' });
    await expect(restoreBackup(host(true), { bytes: BYTES, vaultPath: VAULT_PATH, request, source: 'local_backup_restore' })).rejects.toThrow(
      'Invalid master password',
    );
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });
});
