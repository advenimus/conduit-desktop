// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { LocalBackupService } = await import('../local-backup.js');
const { decryptFromLocalBackup } = await import('../local-backup-crypto.js');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-local-backup-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('LocalBackupService', () => {
  it('backs up a snapshot of the working copy when one is given', async () => {
    const backupPath = path.join(root, 'backups');
    const vaultPath = path.join(root, 'shared.conduit');
    fs.writeFileSync(vaultPath, 'shared file');
    const service = new LocalBackupService();
    service.configure({
      masterPassword: 'pw',
      vaultPath,
      enabled: true,
      backupPath,
      retentionDays: 30,
      snapshot: async (t) => fs.writeFileSync(t, 'working copy'),
    });
    await service.backupNow();
    const [backup] = service.listBackups();
    expect(decryptFromLocalBackup(fs.readFileSync(backup.fullPath), 'pw').toString()).toBe('working copy');
    service.disable();
  });

  it('reads the vault file for vaults opened in place', async () => {
    const backupPath = path.join(root, 'backups');
    const vaultPath = path.join(root, 'private.conduit');
    fs.writeFileSync(vaultPath, 'private file');
    const service = new LocalBackupService();
    service.configure({ masterPassword: 'pw', vaultPath, enabled: true, backupPath, retentionDays: 30 });
    await service.backupNow();
    const [backup] = service.listBackups();
    expect(decryptFromLocalBackup(fs.readFileSync(backup.fullPath), 'pw').toString()).toBe('private file');
    service.disable();
  });
});
