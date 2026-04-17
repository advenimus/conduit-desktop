/**
 * IPC handlers for local folder backup.
 */

import { ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppState } from '../services/state.js';
import { readSettings, writeSettings } from './settings.js';
import { rebuildMutationCallback } from './vault.js';
import { updateRecentVaults } from './settings.js';

export function registerLocalBackupHandlers(): void {
  const state = AppState.getInstance();

  /** Get the current local backup state. */
  ipcMain.handle('local_backup_get_state', async () => {
    return state.localBackup.getState();
  });

  /** Enable local backup: validate path, save settings, configure service, initial backup. */
  ipcMain.handle('local_backup_enable', async (_e, args: { backupPath: string }) => {
    if (!state.vault.isUnlocked() || !state.currentMasterPassword) {
      throw new Error('Vault is locked');
    }

    // Validate path is writable
    const backupPath = args.backupPath;
    try {
      fs.mkdirSync(backupPath, { recursive: true });
      // Test write access
      const testFile = path.join(backupPath, '.conduit-write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        throw new Error('Permission denied. Cannot write to the selected folder.');
      }
      throw new Error(`Cannot write to backup folder: ${(err as Error).message}`);
    }

    // Save to settings
    const settings = readSettings();
    settings.local_backup_enabled = true;
    settings.local_backup_path = backupPath;
    writeSettings(settings);

    // Configure service
    state.localBackup.configure({
      masterPassword: state.currentMasterPassword,
      vaultPath: state.currentVaultPath,
      chatDbPath: state.chatStore.getDbPath(),
      enabled: true,
      backupPath,
      retentionDays: settings.local_backup_retention_days,
      includeChat: settings.local_backup_include_chat,
    });

    // Rebuild mutation callback to include local backup
    rebuildMutationCallback(state);

    // Initial backup
    await state.localBackup.backupNow();
  });

  /** Disable local backup. */
  ipcMain.handle('local_backup_disable', async () => {
    // Save to settings
    const settings = readSettings();
    settings.local_backup_enabled = false;
    writeSettings(settings);

    // Disable service
    state.localBackup.disable();

    // Rebuild mutation callback without local backup
    rebuildMutationCallback(state);
  });

  /** Force immediate backup. */
  ipcMain.handle('local_backup_now', async () => {
    await state.localBackup.backupNow();
  });

  /** List all backup files. */
  ipcMain.handle('local_backup_list', async () => {
    return state.localBackup.listBackups();
  });

  /** Delete a specific backup file. */
  ipcMain.handle('local_backup_delete', async (_e, args: { fullPath: string }) => {
    state.localBackup.deleteBackup(args.fullPath);
  });

  /** Update retention days and/or include_chat settings. */
  ipcMain.handle('local_backup_update_settings', async (_e, args: {
    retentionDays?: number;
    includeChat?: boolean;
  }) => {
    const settings = readSettings();

    if (args.retentionDays !== undefined) {
      settings.local_backup_retention_days = args.retentionDays;
    }
    if (args.includeChat !== undefined) {
      settings.local_backup_include_chat = args.includeChat;
    }

    writeSettings(settings);
    state.localBackup.updateSettings(args);
  });

  /** Open native folder picker dialog. */
  ipcMain.handle('local_backup_select_folder', async () => {
    const win = AppState.getInstance().getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Backup Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** Restore vault from a local backup file. */
  ipcMain.handle('local_backup_restore', async (_e, args: {
    backupFilePath: string;
    masterPassword: string;
  }) => {
    // Decrypt backup
    const rawVault = state.localBackup.restoreFromLocalBackup(
      args.backupFilePath,
      args.masterPassword,
    );

    // Write to vault path (atomic)
    const vaultPath = state.currentVaultPath;
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    const tmpPath = vaultPath + '.tmp';
    fs.writeFileSync(tmpPath, rawVault);
    fs.renameSync(tmpPath, vaultPath);

    // Re-open the vault
    state.switchVault(vaultPath);
    state.vault.unlock(args.masterPassword);

    updateRecentVaults(vaultPath);

    // Store master password and reconfigure local backup
    state.currentMasterPassword = args.masterPassword;
    const settings = readSettings();
    if (settings.local_backup_enabled && settings.local_backup_path) {
      state.localBackup.configure({
        masterPassword: args.masterPassword,
        vaultPath,
        chatDbPath: state.chatStore.getDbPath(),
        enabled: true,
        backupPath: settings.local_backup_path,
        retentionDays: settings.local_backup_retention_days,
        includeChat: settings.local_backup_include_chat,
      });
    }

    rebuildMutationCallback(state);
    return vaultPath;
  });
}
