/**
 * IPC handlers for password history operations.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';

export function registerPasswordHistoryHandlers(): void {
  const state = AppState.getInstance();

  ipcMain.handle('password_history_list', async (_e, args: { entry_id: string; limit?: number }) => {
    return state.getActiveVault().listPasswordHistory(args.entry_id, args.limit);
  });

  ipcMain.handle('password_history_delete', async (_e, args: { id: string }) => {
    state.getActiveVault().deletePasswordHistory(args.id);
    logAudit(state, {
      action: 'password_history_delete',
      targetType: 'password_history',
      targetId: args.id,
    });
  });
}
