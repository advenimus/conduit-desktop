/**
 * IPC handlers for team vault operations.
 *
 * Exposes team vault lifecycle (create, open, close, lock),
 * member management, key rotation, and sync state to the renderer.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';
import { updateLastVaultContext } from './settings.js';

export function registerTeamVaultHandlers(): void {
  const state = AppState.getInstance();
  const mgr = state.teamVaultManager;

  // ---------- Vault lifecycle ----------

  ipcMain.handle('team_vault_create', async (_e, args: { name: string; teamId: string; description?: string }) => {
    const result = await mgr.createTeamVault(args.name, args.teamId, args.description);

    logAudit(state, {
      action: 'vault_create', targetType: 'vault',
      targetId: result.id, targetName: args.name,
      teamVaultId: result.id, teamId: args.teamId,
    });

    return result;
  });

  ipcMain.handle('team_vault_open', async (_e, args: { teamVaultId: string }) => {
    await state.closeAllSessions();
    const vault = await mgr.openTeamVault(args.teamVaultId);
    updateLastVaultContext('team', args.teamVaultId);

    logAudit(state, {
      action: 'vault_access', targetType: 'vault',
      targetId: args.teamVaultId,
    });

    return {
      filePath: vault.getFilePath(),
      teamVaultId: args.teamVaultId,
    };
  });

  ipcMain.handle('team_vault_close', async () => {
    await state.closeAllSessions();
    mgr.closeTeamVault();
    return { success: true };
  });

  ipcMain.handle('team_vault_rename', async (_e, args: { teamVaultId: string; newName: string }) => {
    await mgr.renameTeamVault(args.teamVaultId, args.newName);

    logAudit(state, {
      action: 'vault_rename', targetType: 'vault',
      targetId: args.teamVaultId, targetName: args.newName,
    });

    return { success: true };
  });

  // ---------- Member management ----------

  ipcMain.handle('team_vault_add_member', async (_e, args: {
    teamVaultId: string;
    userId: string;
    role?: 'admin' | 'editor' | 'viewer';
  }) => {
    await mgr.addMember(args.teamVaultId, args.userId, args.role);

    logAudit(state, {
      action: 'member_add', targetType: 'user', targetId: args.userId,
      details: { role: args.role ?? 'editor', team_vault_id: args.teamVaultId },
    });

    return { success: true };
  });

  ipcMain.handle('team_vault_remove_member', async (_e, args: {
    teamVaultId: string;
    userId: string;
  }) => {
    await mgr.removeMember(args.teamVaultId, args.userId);

    logAudit(state, {
      action: 'member_remove', targetType: 'user', targetId: args.userId,
      details: { team_vault_id: args.teamVaultId },
    });

    return { success: true };
  });

  ipcMain.handle('team_vault_update_member_role', async (_e, args: {
    teamVaultId: string;
    userId: string;
    role: 'admin' | 'editor' | 'viewer';
  }) => {
    await mgr.updateMemberRole(args.teamVaultId, args.userId, args.role);

    logAudit(state, {
      action: 'member_role_change', targetType: 'user', targetId: args.userId,
      details: { new_role: args.role, team_vault_id: args.teamVaultId },
    });

    return { success: true };
  });

  ipcMain.handle('team_vault_enroll_admin_all_vaults', async (_e, args: {
    teamId: string;
    userId: string;
  }) => {
    await mgr.enrollAdminInAllVaults(args.teamId, args.userId);
    return { success: true };
  });

  ipcMain.handle('team_vault_list_members', async (_e, args: { teamVaultId: string }) => {
    return mgr.listMembers(args.teamVaultId);
  });

  // ---------- Key rotation ----------

  ipcMain.handle('team_vault_rotate_key', async (_e, args: { teamVaultId: string }) => {
    await mgr.rotateVEK(args.teamVaultId);

    logAudit(state, {
      action: 'vault_access', targetType: 'vault', targetId: args.teamVaultId,
      details: { operation: 'key_rotation' },
    });

    return { success: true };
  });

  // ---------- Sync ----------

  ipcMain.handle('team_vault_sync_now', async () => {
    const sync = mgr.getActiveSync();
    if (!sync) throw new Error('No team vault is currently open');
    await sync.syncNow();
    return { success: true };
  });

  ipcMain.handle('team_vault_sync_state', async () => {
    const sync = mgr.getActiveSync();
    if (!sync) {
      return { status: 'disconnected', lastSyncedAt: null, error: null, pendingChanges: 0 };
    }
    return sync.getState();
  });

  // ---------- Folder permissions ----------

  ipcMain.handle('team_vault_folder_permissions', async (_e, args: { vaultId: string }) => {
    const supabase = state.authService.getSupabaseClient();
    const authState = state.authService.getAuthState();
    if (!authState.user) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('vault_folder_permissions')
      .select('*')
      .eq('vault_id', args.vaultId)
      .eq('user_id', authState.user.id);

    if (error) throw new Error(`Failed to load permissions: ${error.message}`);
    return data ?? [];
  });

  ipcMain.handle('team_vault_list_folder_permissions', async (_e, args: { vaultId: string; folderId: string }) => {
    const supabase = state.authService.getSupabaseClient();

    // Fetch permissions (no FK join — schema cache doesn't have the relationship)
    const { data, error } = await supabase
      .from('vault_folder_permissions')
      .select('*')
      .eq('vault_id', args.vaultId)
      .eq('folder_id', args.folderId)
      .order('created_at');

    if (error) throw new Error(`Failed to list permissions: ${error.message}`);
    if (!data || data.length === 0) return [];

    // Resolve display names via team RPC (direct user_profiles blocked by RLS)
    const { data: vault } = await supabase
      .from('team_vaults')
      .select('team_id')
      .eq('id', args.vaultId)
      .single();

    const nameMap = new Map<string, string>();
    if (vault?.team_id) {
      const { data: teamMembers } = await supabase
        .rpc('get_team_members_with_email', { p_team_id: vault.team_id });
      if (teamMembers) {
        for (const tm of teamMembers as Record<string, unknown>[]) {
          if (tm.user_display_name) {
            nameMap.set(tm.user_id as string, tm.user_display_name as string);
          }
        }
      }
    }

    return data.map((p: Record<string, unknown>) => ({
      ...p,
      user_display_name: nameMap.get(p.user_id as string) ?? null,
    }));
  });

  ipcMain.handle('team_vault_set_folder_permission', async (_e, args: {
    vaultId: string;
    folderId: string;
    userId: string;
    role: 'admin' | 'editor' | 'viewer';
  }) => {
    const supabase = state.authService.getSupabaseClient();
    const authState = state.authService.getAuthState();
    if (!authState.user) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('vault_folder_permissions')
      .upsert({
        vault_id: args.vaultId,
        folder_id: args.folderId,
        user_id: args.userId,
        role: args.role,
        granted_by: authState.user.id,
      }, { onConflict: 'vault_id,folder_id,user_id' });

    if (error) throw new Error(`Failed to set permission: ${error.message}`);

    logAudit(state, {
      action: 'permission_grant', targetType: 'folder', targetId: args.folderId,
      details: { user_id: args.userId, role: args.role, vault_id: args.vaultId },
    });

    return { success: true };
  });

  ipcMain.handle('team_vault_remove_folder_permission', async (_e, args: {
    vaultId: string;
    folderId: string;
    userId: string;
  }) => {
    const supabase = state.authService.getSupabaseClient();

    const { error } = await supabase
      .from('vault_folder_permissions')
      .delete()
      .eq('vault_id', args.vaultId)
      .eq('folder_id', args.folderId)
      .eq('user_id', args.userId);

    if (error) throw new Error(`Failed to remove permission: ${error.message}`);

    logAudit(state, {
      action: 'permission_revoke', targetType: 'folder', targetId: args.folderId,
      details: { user_id: args.userId, vault_id: args.vaultId },
    });

    return { success: true };
  });
}
