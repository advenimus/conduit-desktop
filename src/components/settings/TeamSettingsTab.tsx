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
import { Button, Card, EmptyState, SectionHeader } from "../ui";
import { HINT } from "./settings-styles";

const LIST = "divide-y divide-card-border rounded-md border border-card-border bg-well";

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
    return <EmptyState icon={UsersIcon} title="Not signed in" description="Sign in to access team features" />;
  }

  if (!team) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={UsersIcon}
          title="No team"
          description={
            <>
              You&apos;re not a member of any team yet.
              {profile?.is_team_member ? '' : ' Create or join a team on the website.'}
            </>
          }
          action={
            <Button variant="primary" icon={ExternalLinkIcon} className="mt-2" onClick={() => void window.electron.invoke('auth_open_account')}>
              Manage on conduitdesktop.com
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Team info */}
      <div>
        <SectionHeader title="Team" />
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-selected">
              <UsersIcon size={20} className="text-(--c-accent)" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-semibold text-ink">{team.name}</p>
              <p className={HINT}>
                {members.length} / {team.max_seats} seats
                {myRole && <span className="ml-2 text-ink-secondary">({myRole})</span>}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Members */}
      <div>
        <SectionHeader title="Members" />
        <div className={LIST}>
          {members.map((member) => (
            <div key={member.id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex size-7 items-center justify-center rounded-full bg-selected">
                {member.role === 'admin' ? (
                  <CrownIcon size={14} className="text-warning" />
                ) : (
                  <UserIcon size={14} className="text-ink-muted" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-label font-semibold text-ink">
                  {member.user_display_name ?? member.user_email ?? 'Unknown'}
                </p>
                <p className="text-meta text-ink-faint">
                  {member.role} &middot; joined {new Date(member.joined_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          ))}
          {members.length === 0 && (
            <div className="px-3 py-4 text-center text-meta text-ink-faint">
              No members loaded
            </div>
          )}
        </div>
      </div>

      {/* Team Vaults */}
      <div>
        <SectionHeader
          title="Team Vaults"
          actions={
            myRole === 'admin' && (
              <Button
                variant="ghost"
                size="sm"
                icon={PlusIcon}
                onClick={() => document.dispatchEvent(new CustomEvent('conduit:create-team-vault'))}
              >
                Create
              </Button>
            )
          }
        />
        {teamVaults.length > 0 ? (
          <div className={LIST}>
            {teamVaults.map((vault) => {
              const isActive = vaultType === 'team' && teamVaultId === vault.id;
              return (
                <div key={vault.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-selected">
                    <LockIcon size={14} className="text-(--c-accent)" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-label font-semibold text-ink">
                      {vault.name}
                      {isActive && (
                        <span className="ml-1.5 text-meta font-normal text-ink-secondary">(active)</span>
                      )}
                    </p>
                    <p className="text-meta text-ink-faint">
                      {vault.member_count} {vault.member_count === 1 ? 'member' : 'members'}
                      {vault.description && <span> &middot; {vault.description}</span>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-card-border bg-well px-3 py-4 text-center text-meta text-ink-faint">
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
      <div className="flex items-center gap-2 pt-2">
        {myRole === 'admin' && (
          <Button icon={HistoryIcon} onClick={() => setShowAuditLog(true)}>
            View Audit Log
          </Button>
        )}
        <Button icon={ExternalLinkIcon} onClick={() => void window.electron.invoke('auth_open_account')}>
          Manage team on conduitdesktop.com
        </Button>
      </div>

      {/* Audit log modal */}
      {showAuditLog && (
        <AuditLogViewer onClose={() => setShowAuditLog(false)} />
      )}
    </div>
  );
}
