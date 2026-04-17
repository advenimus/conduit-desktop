/**
 * Amber banner shown in the sidebar when the user has pending team invitations.
 * Polls every 5 minutes for new invitations.
 */

import { useEffect } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { CheckIcon, CloseIcon, UsersIcon } from "../../lib/icons";

export function TeamInvitationBanner() {
  const { pendingInvitations, checkInvitations, acceptInvitation, declineInvitation } = useTeamStore();

  // Poll for invitations every 5 minutes
  useEffect(() => {
    checkInvitations();
    const interval = setInterval(checkInvitations, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkInvitations]);

  if (pendingInvitations.length === 0) return null;

  return (
    <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20">
      {pendingInvitations.map((invitation) => (
        <div key={invitation.id} className="flex items-center gap-2">
          <UsersIcon size={14} className="text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-amber-300 truncate">
              Team invite: <span className="font-medium">{invitation.team_name ?? 'Unknown'}</span>
            </p>
          </div>
          <button
            onClick={() => acceptInvitation(invitation.id)}
            className="p-0.5 rounded hover:bg-amber-500/20 text-amber-400"
            title="Accept"
          >
            <CheckIcon size={14} />
          </button>
          <button
            onClick={() => declineInvitation(invitation.id)}
            className="p-0.5 rounded hover:bg-amber-500/20 text-amber-400/60"
            title="Decline"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
