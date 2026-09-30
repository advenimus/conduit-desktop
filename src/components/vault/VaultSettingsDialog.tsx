import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { useTeamStore, type TeamVaultMember, type FolderPermission } from "../../stores/teamStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { useEntryStore } from "../../stores/entryStore";
import type { FolderData } from "../../types/entry";
import AuditLogViewer from "./AuditLogViewer";
import { ChevronDownIcon, ChevronRightIcon, CrownIcon, FolderIcon, UserIcon } from "../../lib/icons";
import { Badge, Button, Callout, Dialog, DialogFooter, DialogHeader, EmptyState, IconButton, NavList, Select, Spinner, type NavItem } from "../ui";
import { errorText } from "../../lib/errorText";

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

const NAV_ITEMS: ReadonlyArray<NavItem & { id: VaultSettingsTab }> = [
  { id: "members", icon: "users", label: "Members" },
  { id: "permissions", icon: "shieldLock", label: "Permissions" },
  { id: "activity", icon: "history", label: "Activity" },
];

const ROLE_OPTIONS: ReadonlyArray<VaultRole> = ["admin", "editor", "viewer"];

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
      setError(errorText(err, "Failed to add member"));
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
      setError(errorText(err, "Failed to remove member"));
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
      setError(errorText(err, "Failed to update role"));
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
      setError(errorText(err, "Failed to rotate vault key"));
    } finally {
      setActionLoading(null);
    }
  };

  const vaultMemberIds = new Set(vaultMembers.map((m) => m.user_id));
  const availableMembers = teamMembers.filter(
    (m) => !vaultMemberIds.has(m.user_id)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <Callout tone="danger" className="mx-4 mt-3">
          {error}
        </Callout>
      )}

      <div className="flex-1 overflow-y-auto">
        {vaultMembers.length === 0 ? (
          <div className="py-8 text-center text-body text-ink-faint">No members in this vault</div>
        ) : (
          <div className="divide-y divide-divider">
            {vaultMembers.map((member) => {
              const isSelf = member.user_id === user?.id;
              const isRemoving = removingId === member.user_id;
              const isActionLoading = actionLoading === member.user_id;

              return (
                <div key={member.user_id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-selected">
                    {member.role === "admin" ? (
                      <CrownIcon size={16} className="text-warning" />
                    ) : (
                      <UserIcon size={16} className="text-ink-muted" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body text-ink">
                      {member.user_display_name ?? member.user_email ?? "Unknown"}
                      {isSelf && <span className="ml-1 text-label text-ink-faint">(you)</span>}
                    </p>
                    {member.user_email && member.user_display_name && (
                      <p className="truncate text-badge text-ink-faint">{member.user_email}</p>
                    )}
                  </div>

                  {isRemoving ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-label text-danger">Remove?</span>
                      <Button size="sm" variant="danger" onClick={() => handleRemoveMember(member.user_id)} loading={isActionLoading}>
                        Yes
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemovingId(null)}>
                        No
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isTeamAdmin && !isSelf ? (
                        <div className="w-24 shrink-0">
                          <Select
                            value={member.role}
                            onChange={(e) => handleUpdateRole(member.user_id, e.target.value)}
                            disabled={isActionLoading}
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </Select>
                        </div>
                      ) : (
                        <span className="text-label text-ink-muted">{member.role}</span>
                      )}

                      {isTeamAdmin && !isSelf && (
                        <IconButton size="sm" icon="trash" tone="danger" label="Remove member" onClick={() => setRemovingId(member.user_id)} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isTeamAdmin && (
        <div className="border-t border-divider px-4 py-3">
          {addingMember ? (
            <div className="flex items-center gap-2">
              <Select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} wrapperClassName="flex-1">
                <option value="">Select team member...</option>
                {availableMembers.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.user_display_name ?? m.user_email ?? m.user_id}
                  </option>
                ))}
              </Select>
              <div className="w-24 shrink-0">
                <Select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value as VaultRole)}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
              <Button variant="primary" onClick={handleAddMember} disabled={!selectedUserId} loading={actionLoading === "add"}>
                Add
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAddingMember(false);
                  setSelectedUserId("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="link" icon="plus" onClick={() => setAddingMember(true)}>
              Add Team Member
            </Button>
          )}
        </div>
      )}

      {isTeamAdmin && (
        <div className="border-t border-divider px-4 py-3">
          {showRotateConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-label text-warning">Re-encrypt vault key for all members?</span>
              <Button size="sm" variant="primary" onClick={handleRotateKey} loading={actionLoading === "rotate"}>
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowRotateConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setShowRotateConfirm(true)}>
              Rotate Key
            </Button>
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
      setError(errorText(err, "Failed to load folder permissions"));
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
      setError(errorText(err, "Failed to add permission override"));
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
      setError(errorText(err, "Failed to remove permission override"));
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
      <EmptyState
        icon="folder"
        title="No folders in this vault yet."
        description="Create folders to configure per-folder access restrictions."
        className="my-4 flex-1 justify-center"
      />
    );
  }

  const roleSelectOptions = allowedRoles.map((r) => (
    <option key={r} value={r}>
      {r}
    </option>
  ));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <Callout tone="danger" className="mx-4 mt-3">
          {error}
        </Callout>
      )}

      <div className="flex-1 overflow-y-auto">
        {flatNodes.length === 0 ? (
          <div className="py-8 text-center text-body text-ink-faint">
            No folder-level restrictions configured. All members access folders
            based on their vault role.
          </div>
        ) : (
          <div className="divide-y divide-divider">
            {flatNodes.map((node) => {
              const folderId = node.folder.id;
              const isExpanded = expandedFolderId === folderId;
              const count = overrideCounts.get(folderId) ?? 0;
              const perms = folderPerms.get(folderId) ?? [];
              const isLoading = loadingFolder === folderId;
              const isAddingHere = addingOverride === folderId;
              const availableForOverride = getAvailableMembersForFolder(folderId);
              const Chevron = isExpanded ? ChevronDownIcon : ChevronRightIcon;

              return (
                <div key={folderId}>
                  <button
                    type="button"
                    onClick={() => toggleFolder(folderId)}
                   
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-hover"
                    style={{ paddingLeft: `${16 + node.depth * 20}px` }}
                  >
                    <Chevron size={16} className="shrink-0 text-ink-muted" />
                    <FolderIcon size={16} className="shrink-0 text-ink-muted" />
                    <span className="flex-1 truncate text-body text-ink">{node.folder.name}</span>
                    {count > 0 && (
                      <Badge className="shrink-0">
                        {count} {count === 1 ? "override" : "overrides"}
                      </Badge>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-divider bg-well">
                      {isLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Spinner size={16} className="text-ink-muted" />
                        </div>
                      ) : perms.length === 0 && !isAddingHere ? (
                        <div className="px-6 py-3 text-label text-ink-faint">
                          No overrides. Members use their vault-level role for this folder.
                        </div>
                      ) : (
                        <div className="divide-y divide-divider">
                          {perms.map((perm) => {
                            const isRemoveLoading = actionLoading === `remove-${folderId}-${perm.user_id}`;
                            return (
                              <div key={perm.id} className="flex items-center gap-3 px-6 py-2">
                                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected">
                                  <UserIcon size={12} compact className="text-ink-muted" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-label text-ink">
                                    {perm.user_display_name ?? perm.user_email ?? "Unknown"}
                                  </p>
                                </div>
                                <Badge>{perm.role}</Badge>
                                {myVaultRole === "admin" &&
                                  (isRemoveLoading ? (
                                    <span className="flex size-5 items-center justify-center">
                                      <Spinner size={12} className="text-ink-muted" />
                                    </span>
                                  ) : (
                                    <IconButton
                                      size="sm"
                                      icon="trash"
                                      tone="danger"
                                      label="Remove override"
                                      onClick={() => handleRemoveOverride(folderId, perm.user_id)}
                                    />
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {myVaultRole === "admin" && (
                        <div className="border-t border-divider px-6 py-2.5">
                          {isAddingHere ? (
                            <div className="flex items-center gap-2">
                              <Select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} wrapperClassName="flex-1">
                                <option value="">Select member...</option>
                                {availableForOverride.map((m) => (
                                  <option key={m.user_id} value={m.user_id}>
                                    {m.user_display_name ?? m.user_email ?? m.user_id}
                                  </option>
                                ))}
                              </Select>
                              <div className="w-24 shrink-0">
                                <Select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value as VaultRole)}>
                                  {roleSelectOptions}
                                </Select>
                              </div>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleAddOverride(folderId)}
                                disabled={!selectedUserId}
                                loading={actionLoading === "add"}
                              >
                                Add
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setAddingOverride(null);
                                  setSelectedUserId("");
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="link"
                              size="sm"
                              icon="plus"
                              onClick={() => {
                                setAddingOverride(folderId);
                                setSelectedUserId("");
                                setSelectedRole(allowedRoles.includes("viewer") ? "viewer" : allowedRoles[0]);
                              }}
                              disabled={availableForOverride.length === 0}
                            >
                              Add Override
                            </Button>
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

      {flatNodes.length > 0 && Array.from(overrideCounts.values()).every((c) => c === 0) && (
        <div className="border-t border-divider px-4 py-3">
          <p className="text-center text-label text-ink-faint">
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

  const navItems = NAV_ITEMS.filter((item) => item.id !== "activity" || myTeamRole === "admin");

  return (
    <Dialog open title="Vault Settings" width={900} closeOnEscape={false} onClose={onClose} layout="custom">
      <DialogHeader subtitle={activeVault?.name} />

      <div className="flex min-h-0 flex-1 border-y border-divider">
        <NavList
          items={navItems}
          value={activeTab}
          onChange={(id) => setActiveTab(id as VaultSettingsTab)}
          className="w-44 shrink-0 border-r border-divider p-2"
        />

        <div className="flex min-h-[400px] min-w-0 max-h-[calc(85vh-110px)] flex-1 flex-col">
          {loading && activeTab !== "activity" ? (
            <div className="flex flex-1 items-center justify-center py-12">
              <Spinner size={24} className="text-ink-muted" />
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

      <DialogFooter divided>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}
