/**
 * IPC handlers for cloud vault sync.
 */

import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppState } from '../services/state.js';
import { updateRecentVaults, readSettings } from './settings.js';
import { rebuildMutationCallback } from './vault.js';

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

    // Store preference in vault_meta
    state.vault.setCloudSyncEnabled(true);

    // Configure sync service
    state.cloudSync.configure({
      userId: authState.user.id,
      vaultId: state.vault.getVaultId(),
      masterPassword: state.currentMasterPassword,
      vaultPath: state.currentVaultPath,
      enabled: true,
    });

    // Rebuild mutation hook to include cloud sync
    rebuildMutationCallback(state);

    // Initial upload
    await state.cloudSync.syncNow();
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

  /**
   * Restore vault from cloud:
   * 1. Download + decrypt
   * 2. Write to default vault path
   * 3. Unlock the vault
   */
  ipcMain.handle('cloud_vault_restore', async (_e, args: { masterPassword: string }) => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    // Download and decrypt
    const rawVault = await state.cloudSync.downloadVault(
      args.masterPassword,
      authState.user.id,
    );

    // Write to default vault path (atomic: write temp then rename)
    const vaultPath = state.getDefaultVaultPath();
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    const tmpPath = vaultPath + '.tmp';
    fs.writeFileSync(tmpPath, rawVault);
    fs.renameSync(tmpPath, vaultPath);

    // Switch to the restored vault and unlock
    state.switchVault(vaultPath);
    state.vault.unlock(args.masterPassword);

    // Full post-unlock setup (same as vault_unlock handler)
    updateRecentVaults(vaultPath);

    // Store master password for cloud sync
    state.currentMasterPassword = args.masterPassword;

    // Re-enable cloud sync since it was enabled before
    state.vault.setCloudSyncEnabled(true);
    state.cloudSync.configure({
      userId: authState.user.id,
      vaultId: state.vault.getVaultId(),
      masterPassword: args.masterPassword,
      vaultPath,
      enabled: true,
    });
    rebuildMutationCallback(state);

    return vaultPath;
  });

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

  /**
   * Restore vault from a specific backup snapshot:
   * 1. Validate storagePath belongs to the user
   * 2. Download + decrypt
   * 3. Resolve target path: match vault name to recent_vaults, or create {dataDir}/{name}.conduit
   * 4. Write to that path and unlock
   */
  ipcMain.handle('cloud_backup_restore', async (_e, args: {
    storagePath: string;
    masterPassword: string;
    vaultName?: string;
  }) => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }

    // Prevent path traversal — storagePath must start with user's ID
    if (!args.storagePath.startsWith(`${authState.user.id}/`)) {
      throw new Error('Invalid backup path');
    }

    // Download and decrypt the specific backup
    const rawVault = await state.cloudSync.downloadBackup(
      args.storagePath,
      args.masterPassword,
    );

    // Resolve target vault path from vault name
    let vaultPath: string;
    if (args.vaultName) {
      // Try to find existing vault file in recent_vaults matching this name
      const settings = readSettings();
      const match = settings.recent_vaults.find((p) => {
        const filename = p.split('/').pop() ?? p.split('\\').pop() ?? '';
        return filename.replace(/\.conduit$/, '') === args.vaultName;
      });
      vaultPath = match ?? path.join(state.getDataDir(), `${args.vaultName}.conduit`);
    } else {
      vaultPath = state.getDefaultVaultPath();
    }

    // Write to vault path (atomic: write temp then rename)
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    const tmpPath = vaultPath + '.tmp';
    fs.writeFileSync(tmpPath, rawVault);
    fs.renameSync(tmpPath, vaultPath);

    // Switch to the restored vault and unlock
    state.switchVault(vaultPath);
    state.vault.unlock(args.masterPassword);

    // Full post-unlock setup (same as vault_unlock handler)
    updateRecentVaults(vaultPath);

    // Store master password for cloud sync
    state.currentMasterPassword = args.masterPassword;

    // Re-enable cloud sync since it was enabled before
    state.vault.setCloudSyncEnabled(true);
    state.cloudSync.configure({
      userId: authState.user.id,
      vaultId: state.vault.getVaultId(),
      masterPassword: args.masterPassword,
      vaultPath,
      enabled: true,
    });
    rebuildMutationCallback(state);

    return vaultPath;
  });
}
