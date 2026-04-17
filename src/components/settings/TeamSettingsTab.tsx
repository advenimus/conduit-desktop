/**
 * Team settings tab content for the SettingsDialog.
 *
 * Shows team info, read-only member list, invitation status,
 * and links to manage the team on the website.
 */

import { useEffect, useState } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useAuthStore } from '../../stores/authStore';
import AuditLogViewer from '../vault/AuditLogViewer';
import {
  CrownIcon, ExternalLinkIcon, HistoryIcon, LockIcon, PlusIcon, UserIcon, UsersIcon
} from "../../lib/icons";

export default function TeamSettingsTab() {
  const { team, members, myRole, teamVaults, loadTeam, loadMembers, loadTeamVaults } = useTeamStore();
  const { vaultType, teamVaultId } = useVaultStore();
  const { profile, isAuthenticated, authMode } = useAuthStore();
  const [showAuditLog, setShowAuditLog] = useState(false);

  useEffect(() => {
    if (isAuthenticated && authMode === 'authenticated') {
      loadTeam();
      loadMembers();
      loadTeamVaults();
    }
  }, [isAuthenticated, authMode, loadTeam, loadMembers, loadTeamVaults]);

  if (authMode === 'local') {
    return (
      <div className="text-center py-8">
        <UsersIcon size={48} className="text-ink-faint mx-auto mb-3" />
        <p className="text-ink-muted mb-2">Not signed in</p>
        <p className="text-xs text-ink-faint">
          Sign in to access team features
        </p>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="space-y-4">
        <div className="text-center py-8">
          <UsersIcon size={48} className="text-ink-faint mx-auto mb-3" />
          <p className="text-ink-muted mb-2">No team</p>
          <p className="text-xs text-ink-faint mb-4">
            You&apos;re not a member of any team yet.
            {profile?.is_team_member ? '' : ' Create or join a team on the website.'}
          </p>
          <button
            onClick={() => window.electron.invoke('auth_open_account').then(() => {
              // The website handles team creation
            })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-conduit-600 hover:bg-conduit-500 text-white text-xs rounded-md transition-colors"
          >
            <ExternalLinkIcon size={12} />
            Manage on conduitdesktop.com
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Team info */}
      <div>
        <h3 className="text-sm font-medium text-ink mb-2">Team</h3>
        <div className="bg-well rounded-lg p-3 border border-stroke">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-conduit-600/20 flex items-center justify-center">
              <UsersIcon size={20} className="text-conduit-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink truncate">{team.name}</p>
              <p className="text-xs text-ink-muted">
                {members.length} / {team.max_seats} seats
                {myRole && <span className="ml-2 text-conduit-400">({myRole})</span>}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Members */}
      <div>
        <h3 className="text-sm font-medium text-ink mb-2">Members</h3>
        <div className="bg-well rounded-lg border border-stroke divide-y divide-stroke">
          {members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 px-3 py-2">
              <div className="w-7 h-7 rounded-full bg-ink-faint/20 flex items-center justify-center">
                {member.role === 'admin' ? (
                  <CrownIcon size={14} className="text-amber-400" />
                ) : (
                  <UserIcon size={14} className="text-ink-muted" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink truncate">
                  {member.user_display_name ?? member.user_email ?? 'Unknown'}
                </p>
                <p className="text-[10px] text-ink-faint">
                  {member.role} &middot; joined {new Date(member.joined_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          ))}
          {members.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-ink-faint">
              No members loaded
            </div>
          )}
        </div>
      </div>

      {/* Team Vaults */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-ink">Team Vaults</h3>
          {myRole === 'admin' && (
            <button
              onClick={() => document.dispatchEvent(new CustomEvent('conduit:create-team-vault'))}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-conduit-400 hover:text-conduit-300 hover:bg-conduit-500/10 rounded transition-colors"
            >
              <PlusIcon size={12} />
              Create
            </button>
          )}
        </div>
        {teamVaults.length > 0 ? (
          <div className="bg-well rounded-lg border border-stroke divide-y divide-stroke">
            {teamVaults.map((vault) => {
              const isActive = vaultType === 'team' && teamVaultId === vault.id;
              return (
                <div key={vault.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="w-7 h-7 rounded-full bg-conduit-600/20 flex items-center justify-center flex-shrink-0">
                    <LockIcon size={14} className="text-conduit-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-ink truncate">
                      {vault.name}
                      {isActive && (
                        <span className="ml-1.5 text-[10px] text-conduit-400">(active)</span>
                      )}
                    </p>
                    <p className="text-[10px] text-ink-faint">
                      {vault.member_count} {vault.member_count === 1 ? 'member' : 'members'}
                      {vault.description && <span> &middot; {vault.description}</span>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-well rounded-lg border border-stroke px-3 py-4 text-center text-xs text-ink-faint">
            <p>No team vaults yet.</p>
            {myRole !== 'admin' && (() => {
              const admins = members.filter(m => m.role === 'admin');
              const adminNames = admins.map(a => a.user_display_name ?? a.user_email ?? 'Unknown').join(', ');
              return adminNames ? (
                <p className="mt-1">Ask {adminNames} to create the first vault.</p>
              ) : null;
            })()}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="pt-2 flex items-center gap-2">
        {myRole === 'admin' && (
          <button
            onClick={() => setShowAuditLog(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-well hover:bg-raised text-ink text-xs rounded-md border border-stroke transition-colors"
          >
            <HistoryIcon size={12} />
            View Audit Log
          </button>
        )}
        <button
          onClick={() => window.electron.invoke('auth_open_account')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-well hover:bg-raised text-ink text-xs rounded-md border border-stroke transition-colors"
        >
          <ExternalLinkIcon size={12} />
          Manage team on conduitdesktop.com
        </button>
      </div>

      {/* Audit log modal */}
      {showAuditLog && (
        <AuditLogViewer onClose={() => setShowAuditLog(false)} />
      )}
    </div>
  );
}
