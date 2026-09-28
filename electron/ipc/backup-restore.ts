/**
 * Routing of the three backup restores (spec 5.10). When the backup
 * belongs to the vault the sync engine is running, a plain file overwrite would be undone by
 * the next merge, so the restore is a preview, a rollback (interactive writes) or a new vault.
 * A synced vault that is not open (or is soft-locked) is refused: its working copy already
 * holds everything in the backup, so a replaced file would be merged away at the next unlock.
 * Only private vaults and vaults opened with sync off keep the old whole-file replace. The
 * decrypted backup is staged in a private temp folder that is always removed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreFromBackup } from '../services/sync/app-sync-actions.js';
import type { EngineVault } from '../services/sync/app-sync-review.js';
import type { RestoreMode, RestoreResult } from '../services/sync/app-sync-dto.js';
import type { UnlockSource } from '../services/vault-session/open-personal-vault.js';
import {
  InvalidSyncRequest,
  oneOf,
  optionalPassword,
  optionalVaultTarget,
  requirePassword,
  type IpcArgs,
} from './sync-args.js';
import { UserFacingError } from './sync-errors.js';

export const RESTORE_MODES: readonly RestoreMode[] = ['preview', 'rollback', 'new-vault'];
export const RESTORE_NEEDS_SYNC_MESSAGE =
  'This vault is not syncing on this device, so the backup can only replace the whole file. Try the restore again.';
export const RESTORE_GENERIC_MESSAGE = 'The restore could not finish. Try again.';
export const RESTORE_OPEN_VAULT_FIRST_MESSAGE = 'Open and unlock this vault first, then restore the backup into it.';

const STAGE_DIR_PREFIX = 'conduit-restore-';
const STAGE_FILE_NAME = 'backup.conduit';
const PRIVATE_FILE_MODE = 0o600;

export interface RestoreRequest {
  readonly masterPassword: string;
  /** The password the backup was made with, when it differs from today's. */
  readonly backupPassword: string | null;
  /** null: preview when the engine runs, else the whole-file replace. */
  readonly mode: RestoreMode | null;
  /** 'new-vault': where the new vault goes (from a Save dialog). */
  readonly targetPath: string | null;
}

export function parseRestoreRequest(a: IpcArgs): RestoreRequest {
  const mode = a.mode === undefined || a.mode === null ? null : oneOf(a.mode, RESTORE_MODES, 'restore mode');
  const targetPath = optionalVaultTarget(a.targetPath, 'target path');
  if (mode === 'new-vault' && targetPath === null) throw new InvalidSyncRequest('target path');
  return {
    masterPassword: requirePassword(a.masterPassword, 'password'),
    backupPassword: optionalPassword(a.backupPassword, 'backup password'),
    mode,
    targetPath,
  };
}

/** The password that decrypts the backup and opens its vault. */
export function backupPasswordOf(request: RestoreRequest): string {
  return request.backupPassword ?? request.masterPassword;
}

export interface ReplaceInput {
  readonly bytes: Buffer;
  readonly vaultPath: string;
  readonly password: string;
  readonly source: UnlockSource;
}

/** What a restore needs from the app (AppState in production, fakes in tests). */
export interface RestoreHost {
  /** The open engine-managed vault when its shared file is `vaultPath`, else null. */
  engineVaultFor(vaultPath: string): EngineVault | null;
  /** True when `vaultPath` would sync (shared, sync on), so a whole-file replace is unsafe. */
  syncsWhenOpened(vaultPath: string): Promise<boolean>;
  /** Locks what is open, writes `bytes` over `vaultPath` and unlocks it. */
  replaceAndOpen(input: ReplaceInput): Promise<void>;
  readonly tmpRoot?: string;
}

export interface RestoreInput {
  readonly bytes: Buffer;
  readonly vaultPath: string;
  readonly request: RestoreRequest;
  readonly source: UnlockSource;
}

async function withStagedBackup<T>(bytes: Buffer, tmpRoot: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, STAGE_DIR_PREFIX));
  try {
    const file = path.join(dir, STAGE_FILE_NAME);
    await fs.promises.writeFile(file, bytes, { mode: PRIVATE_FILE_MODE });
    return await use(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn('[sync] could not remove a staged backup', { code: (err as NodeJS.ErrnoException)?.code ?? null });
    });
  }
}

export async function restoreBackup(host: RestoreHost, input: RestoreInput): Promise<RestoreResult> {
  const { request } = input;
  const password = backupPasswordOf(request);
  const vault = host.engineVaultFor(input.vaultPath);
  if (vault === null) {
    if (await host.syncsWhenOpened(input.vaultPath)) throw new UserFacingError(RESTORE_OPEN_VAULT_FIRST_MESSAGE);
    if (request.mode === 'rollback' || request.mode === 'new-vault') throw new UserFacingError(RESTORE_NEEDS_SYNC_MESSAGE);
    await host.replaceAndOpen({ bytes: input.bytes, vaultPath: input.vaultPath, password, source: input.source });
    console.info('[sync] backup restored by replacing the vault file', { source: input.source });
    return { mode: 'replaced', path: input.vaultPath };
  }
  const mode = request.mode ?? 'preview';
  const result = await withStagedBackup(input.bytes, host.tmpRoot ?? os.tmpdir(), (file) =>
    restoreFromBackup(vault, file, password, mode, request.targetPath),
  );
  console.info('[sync] backup restore through the sync engine', { source: input.source, mode: result.mode });
  return result;
}
