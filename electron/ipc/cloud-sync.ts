/**
 * IPC handlers for whole-file cloud backup (named "cloud sync" in older code and channels).
 * The plan is checked on enable and on every restore; restores of the vault the sync engine
 * runs become a preview, a rollback or a new vault (backup-restore.ts).
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import type { AuthState } from '../services/auth/supabase.js';
import {
  CLOUD_BACKUP_PLAN_MESSAGE,
  CLOUD_RESTORE_PLAN_MESSAGE,
  requireCloudBackupPlan,
} from '../services/vault/cloud-backup-plan.js';
import type { RestoreResult } from '../services/sync/app-sync-dto.js';
import { readSettings } from './settings.js';
import { rebuildMutationCallback } from './vault.js';
import { backupPasswordOf, parseRestoreRequest, restoreBackup, RESTORE_GENERIC_MESSAGE } from './backup-restore.js';
import {
  appRestoreHost,
  backupSnapshot,
  cloudRestoreTarget,
  downloadForRestore,
  optionalVaultName,
  requireSignedInUser,
  requireStoragePath,
  vaultHasContent,
} from './backup-restore-app.js';
import { handleChannel, type ChannelOptions } from './sync-errors.js';
import type { IpcArgs } from './sync-args.js';

const RESTORE_CHANNEL_OPTIONS: ChannelOptions = { prefix: '[cloud-sync]', genericMessage: RESTORE_GENERIC_MESSAGE };
/** A whole-file cloud restore turns cloud backup back on (it was on when the backup was made). */
const CLOUD_RESTORE_HOST_OPTIONS = { enableCloudBackup: true } as const;

/** The profile read at sign-in may predate a plan change, so plan checks read it again first. */
async function reloadedAuthState(state: AppState): Promise<AuthState> {
  try {
    await state.authService.reloadProfile();
  } catch (err) {
    console.warn('[cloud-sync] Could not re-read the plan; using the last known one:', (err as Error)?.message ?? err);
  }
  return state.authService.getAuthState();
}

async function requireRestorePlan(state: AppState): Promise<{ readonly id: string }> {
  const user = requireSignedInUser(state);
  requireCloudBackupPlan(await reloadedAuthState(state), readSettings(), CLOUD_RESTORE_PLAN_MESSAGE);
  return user;
}

/** Latest cloud copy of the most recently backed-up vault, into the default vault path. */
async function restoreLatestCloudVault(state: AppState, a: IpcArgs): Promise<RestoreResult> {
  const user = await requireRestorePlan(state);
  const request = parseRestoreRequest(a);
  const password = backupPasswordOf(request);
  const bytes = await downloadForRestore(() => state.cloudSync.downloadVault(password, user.id));
  const vaultPath = state.getDefaultVaultPath();
  const host = appRestoreHost(state, CLOUD_RESTORE_HOST_OPTIONS);
  return restoreBackup(host, { bytes, vaultPath, request, source: 'cloud_vault_restore' });
}

/** One backup snapshot, into the recent vault with its name (or a new file of that name). */
async function restoreCloudBackup(state: AppState, a: IpcArgs): Promise<RestoreResult> {
  const user = await requireRestorePlan(state);
  const storagePath = requireStoragePath(a.storagePath, user.id);
  const vaultName = optionalVaultName(a.vaultName);
  const request = parseRestoreRequest(a);
  const password = backupPasswordOf(request);
  const bytes = await downloadForRestore(() => state.cloudSync.downloadBackup(storagePath, password));
  const vaultPath = cloudRestoreTarget(state, vaultName);
  const host = appRestoreHost(state, CLOUD_RESTORE_HOST_OPTIONS);
  return restoreBackup(host, { bytes, vaultPath, request, source: 'cloud_backup_restore' });
}

export function registerCloudSyncHandlers(): void {
  const state = AppState.getInstance();

  /** Check if a cloud vault exists for the current user. */
  ipcMain.handle('cloud_vault_exists', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) return false;
    return state.cloudSync.hasCloudVault(authState.user.id);
  });

  /** Get the current cloud sync state. */
  ipcMain.handle('cloud_sync_get_state', async () => {
    return state.cloudSync.getState();
  });

  /** Enable cloud sync, store preference, do initial upload. */
  ipcMain.handle('cloud_sync_enable', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }
    if (!state.vault.isUnlocked() || !state.currentMasterPassword) {
      throw new Error('Vault is locked');
    }

    // Plan gate: whole-file cloud backup is a Pro and Team feature.
    requireCloudBackupPlan(await reloadedAuthState(state), readSettings(), CLOUD_BACKUP_PLAN_MESSAGE);

    // Store preference in vault_meta
    state.vault.setCloudSyncEnabled(true);

    // Configure sync service
    state.cloudSync.configure({
      userId: authState.user.id,
      vaultId: state.vault.getVaultId(),
      masterPassword: state.currentMasterPassword,
      vaultPath: state.currentVaultPath,
      enabled: true,
      snapshot: backupSnapshot(state),
    });

    // Rebuild mutation hook to include cloud sync
    rebuildMutationCallback(state);

    if (vaultHasContent(state.vault)) await state.cloudSync.syncNow();
  });

  /** Disable cloud sync, clear preference. */
  ipcMain.handle('cloud_sync_disable', async () => {
    if (state.vault.isUnlocked()) {
      state.vault.setCloudSyncEnabled(false);
    }
    state.cloudSync.disable();
    rebuildMutationCallback(state);
  });

  /** Force immediate sync. */
  ipcMain.handle('cloud_sync_now', async () => {
    await state.cloudSync.syncNow();
  });

  /** Restore the latest cloud copy (plan checked; rollback or new vault when the engine runs it). */
  handleChannel(ipcMain, 'cloud_vault_restore', (a) => restoreLatestCloudVault(state, a), RESTORE_CHANNEL_OPTIONS);

  /** Delete the cloud vault from storage and disable sync. */
  ipcMain.handle('cloud_vault_delete', async () => {
    await state.cloudSync.deleteCloudVault();
    state.cloudSync.disable();
    rebuildMutationCallback(state);
    if (state.vault.isUnlocked()) {
      state.vault.setCloudSyncEnabled(false);
    }
  });

  /** List versioned backup snapshots (current vault only). */
  ipcMain.handle('cloud_backup_list', async () => {
    return state.cloudSync.listBackups();
  });

  /** List versioned backup snapshots from ALL cloud-backed vaults. */
  ipcMain.handle('cloud_backup_list_all', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      return [];
    }
    return state.cloudSync.listAllVaultBackups();
  });

  /** Get the user's backup retention days from their tier. */
  ipcMain.handle('cloud_backup_get_retention', async () => {
    return state.cloudSync.getBackupRetentionDays();
  });

  /** Restore one backup snapshot (plan checked; rollback or new vault when the engine runs it). */
  handleChannel(ipcMain, 'cloud_backup_restore', (a) => restoreCloudBackup(state, a), RESTORE_CHANNEL_OPTIONS);
}
