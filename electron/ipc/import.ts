/**
 * IPC handlers for the RDM import feature.
 */

import { ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import { AppState } from '../services/state.js';
import { parseRdmFile, mapToPreviewEntries } from '../services/import/rdm-parser.js';
import { executeImport, detectDuplicates } from '../services/import/rdm-importer.js';
import type { ImportPreviewEntry, ImportResult, DuplicateStrategy } from '../services/import/types.js';

export function registerImportHandlers(): void {
  const state = AppState.getInstance();

  // ── Pick .rdm file ────────────────────────────────────────────────
  ipcMain.handle('import_pick_rdm_file', async () => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import from Remote Desktop Manager',
      filters: [
        { name: 'RDM Export', extensions: ['rdm', 'xml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Parse + preview ───────────────────────────────────────────────
  ipcMain.handle(
    'import_parse_rdm',
    async (
      _e,
      args: { filePath: string },
    ): Promise<ImportPreviewEntry[]> => {
      const rawEntries = parseRdmFile(args.filePath);
      const entries = mapToPreviewEntries(rawEntries);

      // Detect duplicates if vault is unlocked
      const vault = state.getActiveVault();
      if (vault.isUnlocked()) {
        detectDuplicates(entries, vault);
      }

      return entries;
    },
  );

  // ── Execute import ────────────────────────────────────────────────
  ipcMain.handle(
    'import_execute_rdm',
    async (
      _e,
      args: {
        filePath: string;
        maxEntries?: number;
        duplicateStrategy?: DuplicateStrategy;
      },
    ): Promise<ImportResult> => {
      const vault = state.getActiveVault();
      if (!vault.isUnlocked()) {
        throw new Error('Vault must be unlocked to import');
      }

      const rawEntries = parseRdmFile(args.filePath);
      const entries = mapToPreviewEntries(rawEntries);

      // Re-detect duplicates server-side (don't trust renderer)
      detectDuplicates(entries, vault);

      // Compute existing entry count server-side (don't trust renderer)
      const existingEntryCount = vault.listEntries().length;

      return executeImport(vault, entries, {
        maxEntries: args.maxEntries ?? -1,
        existingEntryCount,
        duplicateStrategy: args.duplicateStrategy,
      });
    },
  );

  // ── Save import log ───────────────────────────────────────────────
  ipcMain.handle(
    'import_save_log',
    async (_e, args: { result: ImportResult }): Promise<boolean> => {
      const win = AppState.getInstance().getMainWindow() ?? null;
      const saveResult = await dialog.showSaveDialog(win!, {
        title: 'Save Import Log',
        defaultPath: `conduit-import-${new Date().toISOString().slice(0, 10)}.log`,
        filters: [
          { name: 'Log Files', extensions: ['log', 'txt'] },
        ],
      });

      if (saveResult.canceled || !saveResult.filePath) return false;

      const lines: string[] = [
        `Conduit RDM Import Log`,
        `Date: ${new Date().toISOString()}`,
        ``,
        `Summary:`,
        `  Total parsed: ${args.result.totalParsed}`,
        `  Imported:     ${args.result.imported}`,
        `  Skipped:      ${args.result.skipped}`,
        `  Errors:       ${args.result.errors}`,
        ``,
        `Details:`,
        `${'─'.repeat(70)}`,
      ];

      for (const entry of args.result.entries) {
        const statusIcon = (entry.status === 'imported' || entry.status === 'overwritten') ? '+' : entry.status === 'error' ? '!' : '-';
        lines.push(
          `[${statusIcon}] ${entry.name} (${entry.conduitType}) — ${entry.message}`,
        );
      }

      lines.push(``, `${'─'.repeat(70)}`, `End of log`);

      fs.writeFileSync(saveResult.filePath, lines.join('\n'), 'utf-8');
      return true;
    },
  );
}
