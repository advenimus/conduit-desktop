/**
 * IPC handlers for vault export/import.
 */

import { ipcMain, dialog } from 'electron';
import { AppState } from '../services/state.js';
import {
  exportVault,
  decryptAndPreview,
  importIntoVault,
  type ImportPreview,
  type ImportResult,
} from '../services/vault/export-import.js';

export function registerExportImportHandlers(): void {
  const state = AppState.getInstance();

  // ── Pick save location for export ────────────────────────────────
  ipcMain.handle('export_pick_file', async () => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Vault',
      defaultPath: `vault-export-${new Date().toISOString().slice(0, 10)}.conduit-export`,
      filters: [
        { name: 'Conduit Export', extensions: ['conduit-export'] },
      ],
    });
    return result.canceled ? null : result.filePath;
  });

  // ── Execute export ───────────────────────────────────────────────
  ipcMain.handle(
    'export_execute',
    async (
      _e,
      args: {
        scope: 'full' | 'folder';
        folderIds?: string[];
        passphrase: string;
        outputPath: string;
      },
    ): Promise<{ folderCount: number; entryCount: number }> => {
      const vault = state.getActiveVault();
      if (!vault.isUnlocked()) {
        throw new Error('Vault must be unlocked to export');
      }

      return exportVault(vault, {
        scope: args.scope,
        folderIds: args.folderIds,
        passphrase: args.passphrase,
        outputPath: args.outputPath,
      });
    },
  );

  // ── Pick .conduit-export file to import ──────────────────────────
  ipcMain.handle('import_pick_export_file', async () => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import from Conduit Export',
      filters: [
        { name: 'Conduit Export', extensions: ['conduit-export'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Preview export file (decrypt + metadata, no secrets) ─────────
  ipcMain.handle(
    'import_preview_export',
    async (
      _e,
      args: { filePath: string; passphrase: string },
    ): Promise<ImportPreview> => {
      return decryptAndPreview(args.filePath, args.passphrase);
    },
  );

  // ── Execute import ───────────────────────────────────────────────
  ipcMain.handle(
    'import_execute_export',
    async (
      _e,
      args: {
        filePath: string;
        passphrase: string;
      },
    ): Promise<ImportResult> => {
      const vault = state.getActiveVault();
      if (!vault.isUnlocked()) {
        throw new Error('Vault must be unlocked to import');
      }

      return importIntoVault(vault, args.filePath, args.passphrase);
    },
  );
}
