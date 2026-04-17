import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { useTeamStore, type TeamVaultMember } from "../../stores/teamStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import {
  AlertCircleIcon, CloseIcon, CrownIcon, LoaderIcon, PlusIcon, RefreshIcon, TrashIcon, UserIcon, UsersIcon
} from "../../lib/icons";

interface TeamVaultMembersDialogProps {
  onClose: () => void;
}

export default function TeamVaultMembersDialog({
  onClose,
}: TeamVaultMembersDialogProps) {
  const { teamVaultId } = useVaultStore();
  const { teamVaults, members: teamMembers, loadMembers } = useTeamStore();
  const { user } = useAuthStore();
  const [vaultMembers, setVaultMembers] = useState<TeamVaultMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const activeVault = teamVaults.find((v) => v.id === teamVaultId);
  const currentUserId = user?.id;
  const myVaultMembership = vaultMembers.find(m => m.user_id === currentUserId);
  const isVaultAdmin = myVaultMembership?.role === 'admin';

  useEffect(() => {
    loadVaultMembers();
    loadMembers();
  }, [teamVaultId]);

  const loadVaultMembers = async () => {
    if (!teamVaultId) return;
    setLoading(true);
    setError(null);
    try {
      const members = await invoke<TeamVaultMember[]>(
        "team_vault_list_members",
        { teamVaultId }
      );
      setVaultMembers(members);
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to load vault members");
    } finally {
      setLoading(false);
    }
  };

  const handleAddMember = async () => {
    if (!teamVaultId || !selectedUserId) return;
    setActionLoading("add");
    setError(null);
    try {
      await invoke("team_vault_add_member", {
        teamVaultId,
        userId: selectedUserId,
        role: selectedRole,
      });
      setAddingMember(false);
      setSelectedUserId("");
      setSelectedRole("editor");
      await loadVaultMembers();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to add member");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!teamVaultId) return;
    setActionLoading(userId);
    setError(null);
    try {
      await invoke("team_vault_remove_member", { teamVaultId, userId });
      setRemovingId(null);
      await loadVaultMembers();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to remove member");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdateRole = async (userId: string, role: string) => {
    if (!teamVaultId) return;
    setActionLoading(userId);
    setError(null);
    try {
      await invoke("team_vault_update_member_role", { teamVaultId, userId, role });
      await loadVaultMembers();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to update role");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRotateKey = async () => {
    if (!teamVaultId) return;
    setActionLoading("rotate");
    setError(null);
    try {
      await invoke("team_vault_rotate_key", { teamVaultId });
      setShowRotateConfirm(false);
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to rotate vault key");
    } finally {
      setActionLoading(null);
    }
  };

  // Members in this vault
  const vaultMemberIds = new Set(vaultMembers.map((m) => m.user_id));
  // Team members not yet in the vault
  const availableMembers = teamMembers.filter(
    (m) => !vaultMemberIds.has(m.user_id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <UsersIcon size={20} className="text-conduit-400" />
            <h2 className="text-lg font-semibold text-ink">
              Vault Members
            </h2>
            {activeVault && (
              <span className="text-xs text-ink-faint ml-1">
                {activeVault.name}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded text-ink-muted hover:text-ink"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
            <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Member list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
            </div>
          ) : vaultMembers.length === 0 ? (
            <div className="text-center py-8 text-ink-faint text-sm">
              No members in this vault
            </div>
          ) : (
            <div className="divide-y divide-stroke/50">
              {vaultMembers.map((member) => {
                const isSelf = member.user_id === user?.id;
                const isRemoving = removingId === member.user_id;
                const isActionLoading = actionLoading === member.user_id;

                return (
                  <div
                    key={member.user_id}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <div className="w-7 h-7 rounded-full bg-ink-faint/20 flex items-center justify-center flex-shrink-0">
                      {member.role === "admin" ? (
                        <CrownIcon size={14} className="text-amber-400" />
                      ) : (
                        <UserIcon size={14} className="text-ink-muted" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink truncate">
                        {member.user_display_name ?? member.user_email ?? "Unknown"}
                        {isSelf && (
                          <span className="text-xs text-ink-faint ml-1">(you)</span>
                        )}
                      </p>
                      {member.user_email && member.user_display_name && (
                        <p className="text-[10px] text-ink-faint truncate">
                          {member.user_email}
                        </p>
                      )}
                    </div>

                    {isRemoving ? (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-xs text-red-400">Remove?</span>
                        <button
                          onClick={() => handleRemoveMember(member.user_id)}
                          disabled={isActionLoading}
                          className="px-2 py-0.5 text-xs text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-50"
                        >
                          {isActionLoading ? (
                            <LoaderIcon size={12} className="animate-spin" />
                          ) : (
                            "Yes"
                          )}
                        </button>
                        <button
                          onClick={() => setRemovingId(null)}
                          className="px-2 py-0.5 text-xs hover:bg-raised rounded text-ink-muted"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {isVaultAdmin && !isSelf ? (
                          <select
                            value={member.role}
                            onChange={(e) =>
                              handleUpdateRole(member.user_id, e.target.value)
                            }
                            disabled={isActionLoading}
                            className="text-xs bg-well border border-stroke rounded px-1.5 py-0.5 text-ink disabled:opacity-50"
                          >
                            <option value="admin">admin</option>
                            <option value="editor">editor</option>
                            <option value="viewer">viewer</option>
                          </select>
                        ) : (
                          <span className="text-xs text-ink-muted">
                            {member.role}
                          </span>
                        )}

                        {isVaultAdmin && !isSelf && (
                          <button
                            onClick={() => setRemovingId(member.user_id)}
                            className="p-1 rounded hover:bg-raised text-ink-muted hover:text-red-400"
                            title="Remove member"
                          >
                            <TrashIcon size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add member */}
        {isVaultAdmin && (
          <div className="px-4 py-3 border-t border-stroke">
            {addingMember ? (
              <div className="flex items-center gap-2">
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="flex-1 text-sm bg-well border border-stroke rounded px-2 py-1.5 text-ink"
                >
                  <option value="">Select team member...</option>
                  {availableMembers.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.user_display_name ?? m.user_email ?? m.user_id}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedRole}
                  onChange={(e) =>
                    setSelectedRole(e.target.value as "admin" | "editor" | "viewer")
                  }
                  className="text-sm bg-well border border-stroke rounded px-2 py-1.5 text-ink"
                >
                  <option value="admin">admin</option>
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
                <button
                  onClick={handleAddMember}
                  disabled={!selectedUserId || actionLoading === "add"}
                  className="px-3 py-1.5 text-sm bg-conduit-600 text-white rounded hover:bg-conduit-500 disabled:opacity-50 flex items-center gap-1"
                >
                  {actionLoading === "add" ? (
                    <LoaderIcon size={14} className="animate-spin" />
                  ) : (
                    "Add"
                  )}
                </button>
                <button
                  onClick={() => {
                    setAddingMember(false);
                    setSelectedUserId("");
                  }}
                  className="px-2 py-1.5 text-sm text-ink-muted hover:text-ink rounded hover:bg-raised"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAddingMember(true)}
                className="flex items-center gap-1.5 text-sm text-conduit-400 hover:text-conduit-300"
              >
                <PlusIcon size={16} />
                Add Team Member
              </button>
            )}
          </div>
        )}

        {/* Footer with rotate key */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-stroke">
          {isVaultAdmin && (
            <>
              {showRotateConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-400">
                    Re-encrypt vault key for all members?
                  </span>
                  <button
                    onClick={handleRotateKey}
                    disabled={actionLoading === "rotate"}
                    className="px-2 py-0.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    {actionLoading === "rotate" ? (
                      <LoaderIcon size={12} className="animate-spin" />
                    ) : (
                      "Confirm"
                    )}
                  </button>
                  <button
                    onClick={() => setShowRotateConfirm(false)}
                    className="px-2 py-0.5 text-xs hover:bg-raised rounded text-ink-muted"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowRotateConfirm(true)}
                  className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink"
                >
                  <RefreshIcon size={14} />
                  Rotate Key
                </button>
              )}
            </>
          )}
          {!isVaultAdmin && <div />}
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-raised hover:bg-stroke rounded text-ink"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
