// Vault export and import through the app's IPC (the Export and Import dialogs call the same
// channels after their file pickers): export_execute, import_preview_export, import_execute_export.

import fs from 'node:fs';
import { refreshEntries } from './flows.mjs';
import { invoke } from './ui.mjs';

const TRANSFER_TIMEOUT_MS = 60_000;

/** export_execute of the active vault to `outputPath`; returns {folderCount, entryCount}. */
export async function exportVault(device, outputPath, passphrase, { scope = 'full', folderIds } = {}) {
  if (fs.existsSync(outputPath)) throw new Error(`${outputPath} already exists`);
  const res = await invoke(device, 'export_execute', { scope, folderIds, passphrase, outputPath }, { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!fs.existsSync(outputPath)) throw new Error(`${device.name}: export_execute answered ${JSON.stringify(res)} but wrote no file`);
  return res;
}

/** import_preview_export: {scope, folder_tree, entries, ...} without secrets. */
export function previewExport(device, filePath, passphrase) {
  return invoke(device, 'import_preview_export', { filePath, passphrase }, { timeoutMs: TRANSFER_TIMEOUT_MS });
}

/**
 * import_execute_export into the active vault, then the renderer reloads its entries.
 * Returns {foldersCreated, entriesCreated, credentialRefsRemapped, credentialRefsCleared}.
 */
export async function importExport(device, filePath, passphrase) {
  const res = await invoke(device, 'import_execute_export', { filePath, passphrase }, { timeoutMs: TRANSFER_TIMEOUT_MS });
  await refreshEntries(device);
  return res;
}
