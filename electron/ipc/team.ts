/**
 * IPC handlers for team management.
 *
 * Provides team info, member management, invitation handling,
 * and team vault listing.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';

export function registerTeamHandlers(): void {
  const state = AppState.getInstance();

  // ── Team info ────────────────────────────────────────────────

  ipcMain.handle('team_get', async () => {
    return state.teamService.getTeam();
  });

  ipcMain.handle('team_get_members', async () => {
    return state.teamService.getMembers();
  });

  ipcMain.handle('team_get_my_role', async () => {
    return state.teamService.getMyRole();
  });

  // ── Invitations ──────────────────────────────────────────────

  ipcMain.handle('team_check_invitations', async () => {
    return state.teamService.getPendingInvitations();
  });

  ipcMain.handle('team_accept_invitation', async (_e, args) => {
    const { invitationId } = args as { invitationId: string };

    let teamId: string | undefined;
    try {
      const { data } = await state.authService.getSupabaseClient()
        .from('team_invitations').select('team_id').eq('id', invitationId).single();
      teamId = data?.team_id;
    } catch {}

    await state.teamService.acceptInvitation(invitationId);

    if (teamId) {
      logAudit(state, {
        action: 'invitation_accepted', targetType: 'invitation',
        targetId: invitationId, teamId,
      });
    }
  });

  ipcMain.handle('team_decline_invitation', async (_e, args) => {
    const { invitationId } = args as { invitationId: string };

    let teamId: string | undefined;
    try {
      const { data } = await state.authService.getSupabaseClient()
        .from('team_invitations').select('team_id').eq('id', invitationId).single();
      teamId = data?.team_id;
    } catch {}

    await state.teamService.declineInvitation(invitationId);

    if (teamId) {
      logAudit(state, {
        action: 'invitation_declined', targetType: 'invitation',
        targetId: invitationId, teamId,
      });
    }
  });

  // ── Team vaults ──────────────────────────────────────────────

  ipcMain.handle('team_vault_list', async () => {
    return state.teamService.listTeamVaults();
  });

  // ── Audit log ────────────────────────────────────────────────

  ipcMain.handle('team_audit_log', async (_e, args) => {
    const { teamId, teamVaultId, actions, limit, offset } = args as {
      teamId: string;
      teamVaultId?: string;
      actions?: string[];
      limit?: number;
      offset?: number;
    };
    return state.teamService.getAuditLog({ teamId, teamVaultId, actions, limit, offset });
  });
}
