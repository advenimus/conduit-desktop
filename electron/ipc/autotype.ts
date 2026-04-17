/**
 * IPC handlers for global auto-type (OS-level keystroke simulation).
 *
 * Allows typing credentials into any focused application window,
 * not just Conduit's own sessions.
 */

import { ipcMain } from 'electron';
import { globalTypeText, globalSendTab } from '../services/autotype/global-type.js';

const INTER_STEP_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAutotypeHandlers(): void {
  /** Type a single text string into the focused OS window. */
  ipcMain.handle('autotype:global_type', async (_e, args: { text: string }) => {
    await globalTypeText(args.text);
  });

  /** Type username → Tab → password into the focused OS window. */
  ipcMain.handle('autotype:global_type_sequence', async (_e, args: { username: string; password: string }) => {
    await globalTypeText(args.username);
    await delay(INTER_STEP_DELAY_MS);
    await globalSendTab();
    await delay(INTER_STEP_DELAY_MS);
    await globalTypeText(args.password);
  });
}
