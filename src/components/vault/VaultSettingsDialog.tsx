import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { useTeamStore, type TeamVaultMember, type FolderPermission } from "../../stores/teamStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { useEntryStore } from "../../stores/entryStore";
import type { FolderData } from "../../types/entry";
import AuditLogViewer from "./AuditLogViewer";
import {
  AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CrownIcon, FolderIcon, HistoryIcon, LoaderIcon, PlusIcon, RefreshIcon, ShieldLockIcon, TrashIcon, UserIcon, UsersIcon
} from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";

// ---------- Types ----------

interface VaultSettingsDialogProps {
  initialTab?: VaultSettingsTab;
  initialFolderId?: string;
  onClose: () => void;
}

type VaultSettingsTab = "members" | "permissions" | "activity";
type VaultRole = "admin" | "editor" | "viewer";

const ROLE_RANK: Record<VaultRole, number> = { admin: 3, editor: 2, viewer: 1 };

interface FolderTreeNode {
  folder: FolderData;
  children: FolderTreeNode[];
  depth: number;
}

const NAV_ITEMS: { id: VaultSettingsTab; icon: IconComponent; label: string }[] = [
  { id: "members", icon: UsersIcon, label: "Members" },
  { id: "permissions", icon: ShieldLockIcon, label: "Permissions" },
  { id: "activity", icon: HistoryIcon, label: "Activity" },
];

// ---------- Helpers ----------

function buildFolderTree(folders: FolderData[]): FolderTreeNode[] {
  const childrenMap = new Map<string | null, FolderData[]>();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(f);
  }

  function buildLevel(parentId: string | null, depth: number): FolderTreeNode[] {
    const children = childrenMap.get(parentId) ?? [];
    return children
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((folder) => ({
        folder,
        children: buildLevel(folder.id, depth + 1),
        depth,
      }));
  }

  return buildLevel(null, 0);
}

function flattenTree(nodes: FolderTreeNode[]): FolderTreeNode[] {
  const result: FolderTreeNode[] = [];
  function walk(list: FolderTreeNode[]) {
    for (const node of list) {
      result.push(node);
      walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

/** Return roles at or below the given ceiling role. */
function rolesAtOrBelow(ceiling: VaultRole): VaultRole[] {
  const rank = ROLE_RANK[ceiling];
  return (["admin", "editor", "viewer"] as VaultRole[]).filter(
    (r) => ROLE_RANK[r] <= rank
  );
}

// ---------- Members Tab ----------

function MembersTab({
  teamVaultId,
  vaultMembers,
  isTeamAdmin,
  loadVaultMembers,
}: {
  teamVaultId: string;
  vaultMembers: TeamVaultMember[];
  isTeamAdmin: boolean;
  loadVaultMembers: () => Promise<void>;
}) {
  const { members: teamMembers, loadMembers } = useTeamStore();
  const { user } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<VaultRole>("editor");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    loadMembers();
  }, []);

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

  const vaultMemberIds = new Set(vaultMembers.map((m) => m.user_id));
  const availableMembers = teamMembers.filter(
    (m) => !vaultMemberIds.has(m.user_id)
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
          <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Member list */}
      <div className="flex-1 overflow-y-auto">
        {vaultMembers.length === 0 ? (
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
                      {isTeamAdmin && !isSelf ? (
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

                      {isTeamAdmin && !isSelf && (
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
      {isTeamAdmin && (
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
                  setSelectedRole(e.target.value as VaultRole)
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

      {/* Key rotation */}
      {isTeamAdmin && (
        <div className="px-4 py-3 border-t border-stroke">
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
        </div>
      )}
    </div>
  );
}

// ---------- Folder Permissions Tab ----------

function FolderPermissionsTab({
  teamVaultId,
  vaultMembers,
  myVaultRole,
  initialFolderId,
}: {
  teamVaultId: string;
  vaultMembers: TeamVaultMember[];
  myVaultRole: VaultRole;
  initialFolderId?: string;
}) {
  const { folders } = useEntryStore();
  const { listFolderPermissions } = useTeamStore();

  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(
    initialFolderId ?? null
  );
  const [folderPerms, setFolderPerms] = useState<Map<string, FolderPermission[]>>(
    new Map()
  );
  const [overrideCounts, setOverrideCounts] = useState<Map<string, number>>(
    new Map()
  );
  const [loadingFolder, setLoadingFolder] = useState<string | null>(null);
  const [addingOverride, setAddingOverride] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<VaultRole>("viewer");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const flatNodes = useMemo(() => flattenTree(tree), [tree]);

  const allowedRoles = useMemo(() => rolesAtOrBelow(myVaultRole), [myVaultRole]);

  // Load override counts for all folders on mount
  useEffect(() => {
    loadAllOverrideCounts();
  }, [teamVaultId, folders]);

  // Auto-expand initial folder
  useEffect(() => {
    if (initialFolderId) {
      loadFolderPerms(initialFolderId);
    }
  }, [initialFolderId]);

  const loadAllOverrideCounts = async () => {
    const counts = new Map<string, number>();
    for (const node of flatNodes) {
      try {
        const perms = await listFolderPermissions(teamVaultId, node.folder.id);
        counts.set(node.folder.id, perms.length);
      } catch {
        counts.set(node.folder.id, 0);
      }
    }
    setOverrideCounts(counts);
  };

  const loadFolderPerms = async (folderId: string) => {
    setLoadingFolder(folderId);
    try {
      const perms = await listFolderPermissions(teamVaultId, folderId);
      setFolderPerms((prev) => {
        const next = new Map(prev);
        next.set(folderId, perms);
        return next;
      });
      setOverrideCounts((prev) => {
        const next = new Map(prev);
        next.set(folderId, perms.length);
        return next;
      });
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to load folder permissions");
    } finally {
      setLoadingFolder(null);
    }
  };

  const toggleFolder = (folderId: string) => {
    if (expandedFolderId === folderId) {
      setExpandedFolderId(null);
      setAddingOverride(null);
    } else {
      setExpandedFolderId(folderId);
      setAddingOverride(null);
      loadFolderPerms(folderId);
    }
  };

  const handleAddOverride = async (folderId: string) => {
    if (!selectedUserId || !teamVaultId) return;
    setActionLoading("add");
    setError(null);
    try {
      await invoke("team_vault_set_folder_permission", {
        vaultId: teamVaultId,
        folderId,
        userId: selectedUserId,
        role: selectedRole,
      });
      setAddingOverride(null);
      setSelectedUserId("");
      setSelectedRole("viewer");
      await loadFolderPerms(folderId);
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to add permission override");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveOverride = async (folderId: string, userId: string) => {
    setActionLoading(`remove-${folderId}-${userId}`);
    setError(null);
    try {
      await invoke("team_vault_remove_folder_permission", {
        vaultId: teamVaultId,
        folderId,
        userId,
      });
      await loadFolderPerms(folderId);
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to remove permission override");
    } finally {
      setActionLoading(null);
    }
  };

  // Members available for override in a given folder (not already overridden)
  const getAvailableMembersForFolder = (folderId: string) => {
    const existing = folderPerms.get(folderId) ?? [];
    const existingUserIds = new Set(existing.map((p) => p.user_id));
    return vaultMembers.filter((m) => !existingUserIds.has(m.user_id));
  };

  if (folders.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-center">
          <FolderIcon size={32} className="text-ink-faint mx-auto mb-2" />
          <p className="text-sm text-ink-faint">No folders in this vault yet.</p>
          <p className="text-xs text-ink-faint mt-1">
            Create folders to configure per-folder access restrictions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
          <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Folder tree */}
      <div className="flex-1 overflow-y-auto">
        {flatNodes.length === 0 ? (
          <div className="text-center py-8 text-ink-faint text-sm">
            No folder-level restrictions configured. All members access folders
            based on their vault role.
          </div>
        ) : (
          <div className="divide-y divide-stroke/50">
            {flatNodes.map((node) => {
              const folderId = node.folder.id;
              const isExpanded = expandedFolderId === folderId;
              const count = overrideCounts.get(folderId) ?? 0;
              const perms = folderPerms.get(folderId) ?? [];
              const isLoading = loadingFolder === folderId;
              const isAddingHere = addingOverride === folderId;
              const availableForOverride = getAvailableMembersForFolder(folderId);

              return (
                <div key={folderId}>
                  {/* Folder row */}
                  <button
                    onClick={() => toggleFolder(folderId)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-raised/50 transition-colors text-left"
                    style={{ paddingLeft: `${16 + node.depth * 20}px` }}
                  >
                    {isExpanded ? (
                      <ChevronDownIcon size={14} className="text-ink-muted flex-shrink-0" />
                    ) : (
                      <ChevronRightIcon size={14} className="text-ink-muted flex-shrink-0" />
                    )}
                    <FolderIcon size={16} className="text-ink-muted flex-shrink-0" />
                    <span className="text-sm text-ink flex-1 truncate">
                      {node.folder.name}
                    </span>
                    {count > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-conduit-600/20 text-conduit-400 flex-shrink-0">
                        {count} {count === 1 ? "override" : "overrides"}
                      </span>
                    )}
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="bg-well/30 border-t border-stroke/30">
                      {isLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <LoaderIcon size={18} className="text-conduit-400 animate-spin" />
                        </div>
                      ) : perms.length === 0 && !isAddingHere ? (
                        <div className="px-6 py-3 text-xs text-ink-faint">
                          No overrides. Members use their vault-level role for this folder.
                        </div>
                      ) : (
                        <div className="divide-y divide-stroke/30">
                          {perms.map((perm) => {
                            const isRemoveLoading =
                              actionLoading === `remove-${folderId}-${perm.user_id}`;
                            return (
                              <div
                                key={perm.id}
                                className="flex items-center gap-3 px-6 py-2"
                              >
                                <div className="w-5 h-5 rounded-full bg-ink-faint/20 flex items-center justify-center flex-shrink-0">
                                  <UserIcon size={12} className="text-ink-muted" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-ink truncate">
                                    {perm.user_display_name ?? perm.user_email ?? "Unknown"}
                                  </p>
                                </div>
                                <span className="text-[10px] text-ink-muted px-1.5 py-0.5 bg-well border border-stroke rounded">
                                  {perm.role}
                                </span>
                                {myVaultRole === "admin" && (
                                  <button
                                    onClick={() =>
                                      handleRemoveOverride(folderId, perm.user_id)
                                    }
                                    disabled={isRemoveLoading}
                                    className="p-0.5 rounded hover:bg-raised text-ink-muted hover:text-red-400 disabled:opacity-50"
                                    title="Remove override"
                                  >
                                    {isRemoveLoading ? (
                                      <LoaderIcon size={12} className="animate-spin" />
                                    ) : (
                                      <TrashIcon size={12} />
                                    )}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add override */}
                      {myVaultRole === "admin" && (
                        <div className="px-6 py-2.5 border-t border-stroke/30">
                          {isAddingHere ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={selectedUserId}
                                onChange={(e) => setSelectedUserId(e.target.value)}
                                className="flex-1 text-xs bg-well border border-stroke rounded px-2 py-1 text-ink"
                              >
                                <option value="">Select member...</option>
                                {availableForOverride.map((m) => (
                                  <option key={m.user_id} value={m.user_id}>
                                    {m.user_display_name ?? m.user_email ?? m.user_id}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={selectedRole}
                                onChange={(e) =>
                                  setSelectedRole(e.target.value as VaultRole)
                                }
                                className="text-xs bg-well border border-stroke rounded px-2 py-1 text-ink"
                              >
                                {allowedRoles.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleAddOverride(folderId)}
                                disabled={!selectedUserId || actionLoading === "add"}
                                className="px-2 py-1 text-xs bg-conduit-600 text-white rounded hover:bg-conduit-500 disabled:opacity-50 flex items-center gap-1"
                              >
                                {actionLoading === "add" ? (
                                  <LoaderIcon size={12} className="animate-spin" />
                                ) : (
                                  "Add"
                                )}
                              </button>
                              <button
                                onClick={() => {
                                  setAddingOverride(null);
                                  setSelectedUserId("");
                                }}
                                className="px-2 py-1 text-xs text-ink-muted hover:text-ink rounded hover:bg-raised"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setAddingOverride(folderId);
                                setSelectedUserId("");
                                setSelectedRole(
                                  allowedRoles.includes("viewer") ? "viewer" : allowedRoles[0]
                                );
                              }}
                              disabled={availableForOverride.length === 0}
                              className="flex items-center gap-1.5 text-xs text-conduit-400 hover:text-conduit-300 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <PlusIcon size={14} />
                              Add Override
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Empty state hint */}
      {flatNodes.length > 0 && Array.from(overrideCounts.values()).every((c) => c === 0) && (
        <div className="px-4 py-3 border-t border-stroke">
          <p className="text-xs text-ink-faint text-center">
            No folder-level restrictions configured. All members access folders based on their vault role.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Main Dialog ----------

export default function VaultSettingsDialog({
  initialTab = "members",
  initialFolderId,
  onClose,
}: VaultSettingsDialogProps) {
  const { teamVaultId } = useVaultStore();
  const { teamVaults, myRole: myTeamRole } = useTeamStore();
  const { user } = useAuthStore();

  const [activeTab, setActiveTab] = useState<VaultSettingsTab>(
    initialFolderId ? "permissions" : initialTab
  );
  const [vaultMembers, setVaultMembers] = useState<TeamVaultMember[]>([]);
  const [loading, setLoading] = useState(true);

  const activeVault = teamVaults.find((v) => v.id === teamVaultId);
  const currentUserId = user?.id;
  const myVaultMembership = vaultMembers.find((m) => m.user_id === currentUserId);
  const myVaultRole = myVaultMembership?.role ?? "viewer";

  const loadVaultMembers = useCallback(async () => {
    if (!teamVaultId) return;
    setLoading(true);
    try {
      const members = await invoke<TeamVaultMember[]>(
        "team_vault_list_members",
        { teamVaultId }
      );
      setVaultMembers(members);
    } catch (err) {
      console.error("Failed to load vault members:", err);
    } finally {
      setLoading(false);
    }
  }, [teamVaultId]);

  useEffect(() => {
    loadVaultMembers();
  }, [loadVaultMembers]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[900px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink">
              Vault Settings
            </h2>
            {activeVault && (
              <span className="text-xs text-ink-faint">
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

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-44 flex-shrink-0 border-r border-stroke p-2">
            {NAV_ITEMS.filter((item) => item.id !== "activity" || myTeamRole === "admin").map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
                  activeTab === id
                    ? "bg-conduit-600/20 text-conduit-400"
                    : "text-ink-secondary hover:bg-raised hover:text-ink"
                }`}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-w-0 min-h-[400px] max-h-[calc(85vh-110px)]">
            {loading && activeTab !== "activity" ? (
              <div className="flex items-center justify-center py-12 flex-1">
                <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
              </div>
            ) : activeTab === "members" ? (
              <MembersTab
                teamVaultId={teamVaultId!}
                vaultMembers={vaultMembers}
                isTeamAdmin={myTeamRole === "admin"}
                loadVaultMembers={loadVaultMembers}
              />
            ) : activeTab === "permissions" ? (
              <FolderPermissionsTab
                teamVaultId={teamVaultId!}
                vaultMembers={vaultMembers}
                myVaultRole={myVaultRole}
                initialFolderId={initialFolderId}
              />
            ) : (
              <AuditLogViewer embedded teamVaultId={teamVaultId!} />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-3 border-t border-stroke">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-raised hover:bg-stroke rounded text-ink transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
