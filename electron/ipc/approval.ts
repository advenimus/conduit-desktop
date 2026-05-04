/**
 * IPC handlers for the credential-approval flow.
 *
 * MCP `credential_read` calls go through this dialog so the user explicitly
 * authorizes any decryption of stored secrets.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';

export function registerApprovalHandlers(): void {
  const state = AppState.getInstance();

  // ── approval_respond (credential approval response) ────────────────
  ipcMain.handle(
    'approval_respond',
    async (_e, args: { request_id: string; approved: boolean }) => {
      const resolved = state.approvalManager.resolve(
        args.request_id,
        args.approved,
      );
      if (!resolved) {
        throw new Error('Approval request not found or already resolved');
      }
      return true;
    },
  );

  // ── approval_get_info (renderer fetches details for the dialog) ────
  ipcMain.handle(
    'approval_get_info',
    async (_e, args: { request_id: string }) => {
      return state.approvalManager.getPendingInfo(args.request_id);
    },
  );
}
