import { useState, useEffect, useCallback } from "react";
import { useTeamStore, type FolderPermission } from "../../stores/teamStore";
import { invoke } from "../../lib/electron";
import { useVaultStore } from "../../stores/vaultStore";
import {
  AlertCircleIcon, LoaderIcon, PlusIcon, ShieldIcon, TrashIcon
} from "../../lib/icons";

interface FolderPermissionEditorProps {
  vaultId: string;
  folderId: string;
  folderName: string;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: 'admin' | 'editor' | 'viewer'; label: string; description: string }[] = [
  { value: "admin", label: "Admin", description: "Full access + manage permissions" },
  { value: "editor", label: "Editor", description: "Create, edit, delete entries" },
  { value: "viewer", label: "Viewer", description: "Read-only access" },
];

/**
 * Dialog for managing per-folder permissions in a team vault.
 * Admin users can grant/change/revoke access per folder per member.
 */
export default function FolderPermissionEditor({
  vaultId,
  folderId,
  folderName,
  onClose,
}: FolderPermissionEditorProps) {
  const { members, setFolderPermission, removeFolderPermission, listFolderPermissions } =
    useTeamStore();
  const { teamVaultId } = useVaultStore();

  const [permissions, setPermissions] = useState<FolderPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [vaultMembers, setVaultMembers] = useState<Array<{ user_id: string; role: string }>>([]);

  // Load vault members on mount to determine role ceilings
  useEffect(() => {
    if (!teamVaultId) return;
    invoke<Array<{ user_id: string; role: string }>>('team_vault_list_members', { teamVaultId })
      .then(setVaultMembers)
      .catch(() => {});
  }, [teamVaultId]);

  const ROLE_RANK: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };

  // Helper to get allowed roles for a user (roles at or below their vault ceiling)
  const getAllowedRoles = (userId: string) => {
    const member = vaultMembers.find(m => m.user_id === userId);
    if (!member) return ROLE_OPTIONS;
    const vaultRank = ROLE_RANK[member.role] ?? 1;
    return ROLE_OPTIONS.filter(opt => (ROLE_RANK[opt.value] ?? 1) <= vaultRank);
  };

  const loadPermissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const perms = await listFolderPermissions(vaultId, folderId);
      setPermissions(perms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load permissions");
    } finally {
      setLoading(false);
    }
  }, [vaultId, folderId, listFolderPermissions]);

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  const handleRoleChange = async (userId: string, role: 'admin' | 'editor' | 'viewer') => {
    try {
      await setFolderPermission(vaultId, folderId, userId, role);
      await loadPermissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update permission");
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await removeFolderPermission(vaultId, folderId, userId);
      await loadPermissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove permission");
    }
  };

  const handleAddMember = async (userId: string, role: 'admin' | 'editor' | 'viewer') => {
    try {
      await setFolderPermission(vaultId, folderId, userId, role);
      await loadPermissions();
      setShowAddMember(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add permission");
    }
  };

  // Members not yet in the permissions list
  const availableMembers = members.filter(
    (m) => !permissions.some((p) => p.user_id === m.user_id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-panel border border-stroke rounded-lg shadow-xl w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-stroke">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-conduit-500/10 flex items-center justify-center">
              <ShieldIcon size={18} className="text-conduit-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">
                Folder Permissions
              </h2>
              <p className="text-xs text-ink-muted">
                {folderName}
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {!loading && permissions.length === 0 && (
            <p className="text-sm text-ink-muted text-center py-4">
              No specific permissions set. All vault members have full access to this folder.
            </p>
          )}

          {!loading &&
            permissions.map((perm) => (
              <div
                key={perm.id}
                className="flex items-center justify-between p-3 rounded-md bg-well border border-stroke"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">
                    {perm.user_display_name || perm.user_email || perm.user_id}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <select
                    value={perm.role}
                    onChange={(e) =>
                      handleRoleChange(perm.user_id, e.target.value as 'admin' | 'editor' | 'viewer')
                    }
                    className="text-xs px-2 py-1 rounded bg-panel border border-stroke text-ink cursor-pointer"
                  >
                    {getAllowedRoles(perm.user_id).map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRemove(perm.user_id)}
                    className="p-1 text-ink-muted hover:text-red-400 transition-colors"
                    title="Remove permission"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))}

          {/* Add member section */}
          {!loading && showAddMember && availableMembers.length > 0 && (
            <div className="p-3 rounded-md bg-well border border-stroke space-y-2">
              <p className="text-xs text-ink-muted font-medium">
                Add member
              </p>
              {availableMembers.map((member) => (
                <div
                  key={member.user_id}
                  className="flex items-center justify-between"
                >
                  <span className="text-sm text-ink truncate">
                    {member.user_display_name || member.user_email || member.user_id}
                  </span>
                  <div className="flex gap-1 ml-2">
                    {getAllowedRoles(member.user_id).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleAddMember(member.user_id, opt.value)}
                        className="px-2 py-0.5 text-xs rounded bg-panel border border-stroke text-ink-secondary hover:text-ink hover:border-conduit-500/50 transition-colors"
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-stroke flex justify-between">
          {availableMembers.length > 0 && (
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-conduit-400 hover:text-conduit-300 rounded-md hover:bg-conduit-500/10 transition-colors"
            >
              <PlusIcon size={14} />
              Add Member
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
