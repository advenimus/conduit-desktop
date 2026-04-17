/**
 * IPC handlers for tool approval flow.
 *
 * Handles both the legacy credential-only approval and the new unified
 * tool approval system.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { TOOL_REGISTRY } from '../services/ai/tool-registry.js';

export function registerApprovalHandlers(): void {
  const state = AppState.getInstance();

  // ── Legacy: approval_respond (credential-only, backward compat) ─────
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

  // ── Legacy: approval_get_info ───────────────────────────────────────
  ipcMain.handle(
    'approval_get_info',
    async (_e, args: { request_id: string }) => {
      return state.approvalManager.getPendingInfo(args.request_id);
    },
  );

  // ── tool_approval_respond ───────────────────────────────────────────
  ipcMain.handle(
    'tool_approval_respond',
    async (_e, args: { request_id: string; approved: boolean; always_allow: boolean }) => {
      // Gracefully handle already-resolved or timed-out requests — the
      // renderer may still show a stale card after the 120s timeout fires
      // or after the Stop button calls denyAllPending().
      return state.toolApproval.resolve(args.request_id, {
        approved: args.approved,
        alwaysAllow: args.always_allow,
      });
    },
  );

  // ── tool_approval_get_allowed ───────────────────────────────────────
  ipcMain.handle('tool_approval_get_allowed', async () => {
    return state.toolApproval.getAllAlwaysAllowed();
  });

  // ── tool_approval_remove_allowed ────────────────────────────────────
  ipcMain.handle(
    'tool_approval_remove_allowed',
    async (_e, args: { tool_name: string }) => {
      state.toolApproval.removeAlwaysAllowed(args.tool_name);
      return true;
    },
  );

  // ── tool_approval_clear_allowed ─────────────────────────────────────
  ipcMain.handle('tool_approval_clear_allowed', async () => {
    state.toolApproval.clearAlwaysAllowed();
    return true;
  });

  // ── tool_approval_set_enabled ─────────────────────────────────────
  ipcMain.handle(
    'tool_approval_set_enabled',
    async (_e, args: { enabled: boolean }) => {
      state.toolApproval.setEnabled(args.enabled);
      return true;
    },
  );

  // ── tool_registry_list ──────────────────────────────────────────────
  ipcMain.handle('tool_registry_list', async () => {
    return TOOL_REGISTRY.map((entry) => ({
      name: entry.name,
      description: entry.description,
      category: entry.category,
    }));
  });
}
