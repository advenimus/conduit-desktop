// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

vi.mock('../vault.js', () => ({ finishPersonalUnlock: vi.fn(), lockVaultFromMain: vi.fn() }));
vi.mock('../settings.js', () => ({ readSettings: () => ({ recent_vaults: [] }) }));

const { DOWNLOAD_FAILED_MESSAGE, downloadForRestore, optionalVaultName, requireStoragePath, vaultHasContent } = await import('../backup-restore-app.js');

describe('cloud restore inputs', () => {
  it('keeps backup paths inside the user folder', () => {
    expect(requireStoragePath('u1/v1/backups/vault_2026.enc', 'u1')).toBe('u1/v1/backups/vault_2026.enc');
    expect(() => requireStoragePath('u2/v1/backups/x.enc', 'u1')).toThrow('Invalid sync request: backup path');
    expect(() => requireStoragePath('u1/../u2/x.enc', 'u1')).toThrow('Invalid sync request: backup path');
    expect(() => requireStoragePath('u1//x.enc', 'u1')).toThrow('Invalid sync request: backup path');
    expect(() => requireStoragePath(42, 'u1')).toThrow('Invalid sync request: backup path');
  });

  it('accepts only plain vault names', () => {
    expect(optionalVaultName(undefined)).toBeNull();
    expect(optionalVaultName('Work Vault')).toBe('Work Vault');
    expect(() => optionalVaultName('../../etc/passwd')).toThrow('Invalid sync request: vault name');
    expect(() => optionalVaultName('a\\b')).toThrow('Invalid sync request: vault name');
    expect(() => optionalVaultName('..')).toThrow('Invalid sync request: vault name');
  });

  it('turns download failures into one plain message but keeps password errors', async () => {
    silenceConsole();
    await expect(downloadForRestore(async () => Promise.reject(new Error('Failed to download backup: 503')))).rejects.toThrow(
      DOWNLOAD_FAILED_MESSAGE,
    );
    const wrong = new Error('Invalid master password. The cloud vault could not be decrypted.');
    await expect(downloadForRestore(async () => Promise.reject(wrong))).rejects.toBe(wrong);
    await expect(downloadForRestore(async () => Buffer.from('ok'))).resolves.toEqual(Buffer.from('ok'));
  });
});

describe('first cloud upload', () => {
  const vault = (entries: number, folders: number) => ({ listEntries: () => new Array(entries).fill({}), listFolders: () => new Array(folders).fill({}) });

  it('waits for content, so a vault created with cloud backup on never uploads an empty backup', () => {
    expect(vaultHasContent(vault(0, 0))).toBe(false);
    expect(vaultHasContent(vault(1, 0))).toBe(true);
    expect(vaultHasContent(vault(0, 1))).toBe(true);
  });
});
