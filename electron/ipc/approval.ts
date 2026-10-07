/**
 * IPC handlers for the reveal dialog. An agent that asks to see a secret's plain value waits
 * here until the user clicks Allow or Deny (docs/KNOWLEDGE_BASE.md 2.2).
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { clearSecretScrubber } from '../ipc-server/secret-guard.js';
import { onPersonalLocked } from './vault-events.js';

export const REVEAL_REQUEST_EVENT = 'mcp:approval_request';
export const REVEAL_RESOLVED_EVENT = 'mcp:approval_resolved';

export function registerApprovalHandlers(): void {
  const state = AppState.getInstance();

  const send = (channel: string, payload: unknown): boolean => {
    const win = state.getMainWindow();
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  };

  state.approvalManager.setNotifier({
    requested: (info) => {
      if (!send(REVEAL_REQUEST_EVENT, info)) {
        state.approvalManager.resolve(info.request_id, false);
        return;
      }
      const win = state.getMainWindow();
      if (win && !win.isFocused()) win.flashFrame(true);
    },
    resolved: (requestId, approved) => {
      send(REVEAL_RESOLVED_EVENT, { request_id: requestId, approved });
    },
  });

  ipcMain.handle('approval_respond', async (_e, args: { request_id: string; approved: boolean }) => {
    if (!state.approvalManager.resolve(args.request_id, args.approved === true)) {
      throw new Error('This request already timed out or was answered');
    }
    return true;
  });

  // The renderer asks on mount, so a request that arrived before the dialog loaded is not lost.
  ipcMain.handle('approval_list_pending', async () => state.approvalManager.listPending());

  // A lock drops the scrubber's decrypted values and answers every waiting reveal with Deny.
  onPersonalLocked(() => {
    state.approvalManager.denyAll();
    clearSecretScrubber();
  });
}
