/**
 * IPC handlers for folder CRUD.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';

export function registerFolderHandlers(): void {
  const state = AppState.getInstance();

  // ── folder_list ──────────────────────────────────────────────
  ipcMain.handle('folder_list', async () => {
    const vault = state.getActiveVault();
    if (!vault.isUnlocked()) return [];
    return vault.listFolders();
  });

  // ── folder_create ────────────────────────────────────────────
  ipcMain.handle('folder_create', async (_e, args: { name: string; parent_id?: string | null; icon?: string | null; color?: string | null }) => {
    const folder = state.getActiveVault().createFolder({
      name: args.name,
      parent_id: args.parent_id,
      icon: args.icon,
      color: args.color,
    });

    logAudit(state, {
      action: 'folder_create', targetType: 'folder',
      targetId: folder.id, targetName: folder.name,
      details: { parent_id: args.parent_id ?? null },
    });

    return folder;
  });

  // ── folder_update ────────────────────────────────────────────
  ipcMain.handle('folder_update', async (_e, args: {
    id: string;
    name?: string;
    parent_id?: string | null;
    sort_order?: number;
    icon?: string | null;
    color?: string | null;
  }) => {
    const { id, ...input } = args;

    let previousName: string | undefined;
    try { previousName = state.getActiveVault().listFolders().find(f => f.id === id)?.name; } catch {}

    const result = state.getActiveVault().updateFolder(id, input);

    logAudit(state, {
      action: 'folder_update', targetType: 'folder',
      targetId: id, targetName: result.name,
      details: {
        changed_fields: Object.keys(input),
        ...(previousName && previousName !== result.name ? { previous_name: previousName } : {}),
      },
    });

    return result;
  });

  // ── folder_delete ────────────────────────────────────────────
  ipcMain.handle('folder_delete', async (_e, args: { id: string }) => {
    let folderName: string | undefined;
    try { folderName = state.getActiveVault().listFolders().find(f => f.id === args.id)?.name; } catch {}

    state.getActiveVault().deleteFolder(args.id);

    logAudit(state, {
      action: 'folder_delete', targetType: 'folder',
      targetId: args.id, targetName: folderName,
    });
  });

  // ── folder_move ──────────────────────────────────────────────
  ipcMain.handle('folder_move', async (_e, args: { id: string; parent_id: string | null }) => {
    let folderMeta: { name?: string; parent_id?: string | null } = {};
    try {
      const f = state.getActiveVault().listFolders().find(f => f.id === args.id);
      if (f) folderMeta = { name: f.name, parent_id: f.parent_id };
    } catch {}

    const result = state.getActiveVault().updateFolder(args.id, { parent_id: args.parent_id });

    logAudit(state, {
      action: 'folder_update', targetType: 'folder',
      targetId: args.id, targetName: folderMeta.name,
      details: {
        changed_fields: ['parent_id'],
        previous_parent_id: folderMeta.parent_id ?? null,
        new_parent_id: args.parent_id,
      },
    });

    return result;
  });
}
