import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStorage } from 'electron';
import { getDataDir } from '../env-config.js';
import { createAutoUnlockStore, type AutoUnlockStore } from './auto-unlock-store.js';

const execFileAsync = promisify(execFile);
const TMUTIL_TIMEOUT_MS = 5_000;

let instance: AutoUnlockStore | null = null;

export function getAutoUnlockStore(): AutoUnlockStore {
  instance ??= createAutoUnlockStore({
    safeStorage,
    platform: process.platform,
    env: process.env,
    dataDir: getDataDir,
    excludeFromBackup: async (dir) => {
      try {
        await execFileAsync('tmutil', ['addexclusion', dir], { timeout: TMUTIL_TIMEOUT_MS });
      } catch {
        // tmutil can be refused without Full Disk Access; the attribute it sets needs none.
        await execFileAsync('xattr', ['-w', 'com.apple.metadata:com_apple_backup_excludeItem', 'com.apple.backupd', dir], { timeout: TMUTIL_TIMEOUT_MS });
      }
    },
    now: () => Date.now(),
  });
  return instance;
}
