/**
 * Amber banner shown in the sidebar when the user has pending team invitations.
 * Polls every 5 minutes for new invitations.
 */

import { useEffect } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { UsersIcon } from "../../lib/icons";
import { IconButton } from "../ui";

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
    <div>
      {pendingInvitations.map((invitation) => (
        <div
          key={invitation.id}
          className="flex items-center gap-2 px-2 py-1.5 bg-warning-bg border-b border-warning-border"
        >
          <UsersIcon size={16} className="text-warning shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-label text-ink truncate">
              Team invite: <span className="font-semibold">{invitation.team_name ?? 'Unknown'}</span>
            </p>
          </div>
          <IconButton size="sm" icon="check" label="Accept" onClick={() => acceptInvitation(invitation.id)} />
          <IconButton size="sm" icon="close" label="Decline" onClick={() => declineInvitation(invitation.id)} />
        </div>
      ))}
    </div>
  );
}
