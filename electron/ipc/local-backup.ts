/**
 * IPC handlers for local folder backup. A restore of the vault the sync engine runs becomes a
 * preview, a rollback or a new vault (backup-restore.ts); other vaults are replaced as before.
 */

import { ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppState } from '../services/state.js';
import type { RestoreResult } from '../services/sync/app-sync-dto.js';
import { readSettings, writeSettings } from './settings.js';
import { rebuildMutationCallback } from './vault.js';
import { backupPasswordOf, parseRestoreRequest, restoreBackup, RESTORE_GENERIC_MESSAGE } from './backup-restore.js';
import { appRestoreHost, backupSnapshot } from './backup-restore-app.js';
import { InvalidSyncRequest, requireFilePath, type IpcArgs } from './sync-args.js';
import { handleChannel } from './sync-errors.js';

const LOCAL_BACKUP_EXTENSION = '.enc';

function requireBackupFile(v: unknown): string {
  const file = requireFilePath(v, 'backup file');
  if (!file.toLowerCase().endsWith(LOCAL_BACKUP_EXTENSION)) throw new InvalidSyncRequest('backup file');
  return file;
}

async function restoreLocalBackup(state: AppState, a: IpcArgs): Promise<RestoreResult> {
  const backupFile = requireBackupFile(a.backupFilePath);
  const request = parseRestoreRequest(a);
  const bytes = state.localBackup.restoreFromLocalBackup(backupFile, backupPasswordOf(request));
  return restoreBackup(appRestoreHost(state), { bytes, vaultPath: state.currentVaultPath, request, source: 'local_backup_restore' });
}

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
      enabled: true,
      backupPath,
      retentionDays: settings.local_backup_retention_days,
      snapshot: backupSnapshot(state),
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

  /** Update retention days. */
  ipcMain.handle('local_backup_update_settings', async (_e, args: {
    retentionDays?: number;
  }) => {
    const settings = readSettings();

    if (args.retentionDays !== undefined) {
      settings.local_backup_retention_days = args.retentionDays;
    }

    writeSettings(settings);
    state.localBackup.updateSettings({ retentionDays: args.retentionDays });
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

  /** Restore from a local backup file (rollback or new vault when the engine runs the vault). */
  handleChannel(ipcMain, 'local_backup_restore', (a) => restoreLocalBackup(state, a), {
    prefix: '[local-backup]',
    genericMessage: RESTORE_GENERIC_MESSAGE,
  });
}
