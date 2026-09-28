/**
 * The app side of backup restores and backup wiring: which vault a restore targets, the checks
 * it runs first, the whole-file replace of a vault that does not sync, and the snapshot
 * source backups use for vaults the sync engine manages (spec 5.10).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import { sameRealpath } from '../services/sync/host-electron-settings.js';
import type { SnapshotWriter } from '../services/vault/backup-snapshot.js';
import { CLOUD_BACKUP_DAMAGED_MESSAGE } from '../services/vault/cloud-crypto.js';
import type { ReplaceInput, RestoreHost } from './backup-restore.js';
import { readSettings } from './settings.js';
import { InvalidSyncRequest } from './sync-args.js';
import { UserFacingError } from './sync-errors.js';
import { finishPersonalUnlock, lockVaultFromMain } from './vault.js';

export const SIGN_IN_TO_RESTORE_MESSAGE = 'Sign in to restore a cloud backup.';
export const DOWNLOAD_FAILED_MESSAGE = 'Could not download the backup. Check your connection and try again.';

const PRIVATE_FILE_MODE = 0o600;
const MAX_VAULT_NAME_LENGTH = 255;
const MAX_STORAGE_PATH_LENGTH = 1024;
const SQLITE_SIDE_FILES = ['-wal', '-shm'] as const;
const VAULT_EXTENSION_RE = /\.conduit$/i;

/** Backups of an engine-managed vault read a VACUUM INTO snapshot of its working copy. */
export function backupSnapshot(state: AppState): SnapshotWriter | null {
  return state.appSync.isEngineManaged() ? (target) => state.appSync.snapshotForBackup(target) : null;
}

/**
 * The new-vault form turns cloud backup on before anything is in the vault; its first upload
 * waits for content (the next edit), so the oldest cloud backup is never an empty vault.
 */
export function vaultHasContent(vault: { listEntries(): readonly unknown[]; listFolders(): readonly unknown[] }): boolean {
  return vault.listEntries().length > 0 || vault.listFolders().length > 0;
}

export function requireSignedInUser(state: AppState): { readonly id: string } {
  const auth = state.authService.getAuthState();
  if (!auth.isAuthenticated || !auth.user) throw new UserFacingError(SIGN_IN_TO_RESTORE_MESSAGE);
  return auth.user;
}

/** A backup object in the user's own folder, without `..` or empty segments. */
export function requireStoragePath(v: unknown, userId: string): string {
  if (typeof v !== 'string' || v.length > MAX_STORAGE_PATH_LENGTH || !v.startsWith(`${userId}/`)) {
    throw new InvalidSyncRequest('backup path');
  }
  if (v.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new InvalidSyncRequest('backup path');
  return v;
}

/** A plain file name (no folders), used to find or name the restored vault. */
export function optionalVaultName(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const ok = typeof v === 'string' && v.length <= MAX_VAULT_NAME_LENGTH && !/[\\/\0]/.test(v) && v !== '.' && v !== '..';
  if (!ok) throw new InvalidSyncRequest('vault name');
  return v;
}

/** A recent vault with that name, else `{dataDir}/{name}.conduit`; no name: the default vault. */
export function cloudRestoreTarget(state: AppState, vaultName: string | null): string {
  if (vaultName === null) return state.getDefaultVaultPath();
  const match = readSettings().recent_vaults.find((p) => path.basename(p).replace(VAULT_EXTENSION_RE, '') === vaultName);
  return match ?? path.join(state.getDataDir(), `${vaultName}.conduit`);
}

/** Download errors other than a wrong password or a damaged blob become one plain message. */
export async function downloadForRestore(download: () => Promise<Buffer>): Promise<Buffer> {
  try {
    return await download();
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    if (message.startsWith('Invalid master password') || message === CLOUD_BACKUP_DAMAGED_MESSAGE) throw err;
    console.error('[cloud-sync] backup download failed:', message);
    throw new UserFacingError(DOWNLOAD_FAILED_MESSAGE);
  }
}

/** Stale side files of the replaced vault would be replayed onto the restored file. */
function writeVaultFile(vaultPath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  for (const suffix of SQLITE_SIDE_FILES) fs.rmSync(`${vaultPath}${suffix}`, { force: true });
  const tmp = `${vaultPath}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: PRIVATE_FILE_MODE });
  fs.renameSync(tmp, vaultPath);
}

export interface ReplaceOptions {
  /** Cloud restores turn cloud backup back on (it was on when the backup was made). */
  readonly enableCloudBackup?: boolean;
}

async function replaceAndOpen(state: AppState, input: ReplaceInput, opts: ReplaceOptions): Promise<void> {
  await lockVaultFromMain();
  writeVaultFile(input.vaultPath, input.bytes);
  state.switchVault(input.vaultPath);
  const opened = await state.appSync.openPersonalVault({ path: input.vaultPath, password: input.password, source: input.source });
  if (opts.enableCloudBackup) state.vault.setCloudSyncEnabled(true);
  await finishPersonalUnlock(input.password, opened.lineageId);
}

export function appRestoreHost(state: AppState, opts: ReplaceOptions = {}): RestoreHost {
  return {
    engineVaultFor: (vaultPath) =>
      state.appSync.isEngineManaged() && sameRealpath(state.currentVaultPath, vaultPath, process.platform) ? state.appSync.engineVault() : null,
    syncsWhenOpened: (vaultPath) => state.appSync.syncsWhenOpened(vaultPath),
    replaceAndOpen: (input) => replaceAndOpen(state, input, opts),
  };
}
