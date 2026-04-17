/**
 * Fire-and-forget audit logging for team vault operations.
 *
 * Skips silently for personal vaults (no teamId).
 * Never awaits — errors are logged to console.
 */

import type { AppState } from './state.js';

export interface AuditEvent {
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  details?: Record<string, unknown>;
  teamVaultId?: string;  // override for non-active vault operations
  teamId?: string;       // override for team-level events (invitations)
}

export function logAudit(state: AppState, event: AuditEvent): void {
  const teamVaultId = event.teamVaultId ?? state.teamVaultManager.getActiveVaultId();
  const teamId = event.teamId ?? state.teamVaultManager.getActiveTeamId();

  if (!teamId) return; // personal vault — skip

  state.teamService.recordAuditEvent({
    teamId,
    teamVaultId: teamVaultId ?? undefined,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    targetName: event.targetName,
    details: event.details,
  }).catch((err: unknown) => {
    console.warn('[audit] Failed to log event:', event.action, err);
  });
}
