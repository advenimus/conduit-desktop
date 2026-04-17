/**
 * Lightweight key-value store for transient UI state that should persist across restarts.
 * Backed by a JSON file in the app's userData directory.
 * Separate from settings.json to keep typed app config clean.
 */

import { ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir } from '../services/env-config.js';

function uiStatePath(): string {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'ui-state.json');
}

export function readAll(): Record<string, unknown> {
  const filePath = uiStatePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeAll(data: Record<string, unknown>): void {
  fs.writeFileSync(uiStatePath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function registerUiStateHandlers(): void {
  ipcMain.handle('ui_state_get', async (_e, args: { key: string }) => {
    const all = readAll();
    return all[args.key] ?? null;
  });

  ipcMain.handle('ui_state_set', async (_e, args: { key: string; value: unknown }) => {
    const all = readAll();
    all[args.key] = args.value;
    writeAll(all);
  });
}
