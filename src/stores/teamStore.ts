import { create } from 'zustand';
import { invoke } from '../lib/electron';

// ---------- Types ----------

export interface Team {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  max_seats: number;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: string;
  user_email?: string;
  user_display_name?: string;
}

export interface TeamInvitation {
  id: string;
  team_id: string;
  email: string;
  role: 'admin' | 'member';
  status: string;
  token: string;
  expires_at: string;
  created_at: string;
  team_name?: string;
}

export interface TeamVaultSummary {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  created_by: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface TeamVaultMember {
  user_id: string;
  role: 'admin' | 'editor' | 'viewer';
  user_email?: string;
  user_display_name?: string;
  created_at: string;
}

export interface FolderPermission {
  id: string;
  vault_id: string;
  folder_id: string;
  user_id: string;
  role: 'admin' | 'editor' | 'viewer';
  granted_by: string | null;
  created_at: string;
  user_email?: string;
  user_display_name?: string;
}

export interface AuditLogEntry {
  id: string;
  team_id: string;
  team_vault_id: string | null;
  actor_id: string;
  actor_email: string;
  actor_display_name?: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

// ---------- Role ranking ----------

const ROLE_RANK: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };

function minRole(
  a: 'admin' | 'editor' | 'viewer',
  b: 'admin' | 'editor' | 'viewer',
): 'admin' | 'editor' | 'viewer' {
  return (ROLE_RANK[a] <= ROLE_RANK[b]) ? a : b;
}

// ---------- Store ----------

interface TeamStoreState {
  team: Team | null;
  members: TeamMember[];
  myRole: 'admin' | 'member' | null;
  pendingInvitations: TeamInvitation[];
  teamVaults: TeamVaultSummary[];
  auditLog: AuditLogEntry[];
  isLoading: boolean;
  error: string | null;

  // Vault-level role for the current user in the active team vault
  myVaultRole: 'admin' | 'editor' | 'viewer' | null;

  // Folder permissions (per-user cache for current vault)
  folderPermissions: Map<string, 'admin' | 'editor' | 'viewer'>;
  /** True if NO folder permissions exist for the vault (all members get full access). */
  permissionsUnconfigured: boolean;

  // Data loading
  loadTeam: () => Promise<void>;
  loadMembers: () => Promise<void>;
  checkInvitations: () => Promise<void>;
  loadTeamVaults: () => Promise<void>;
  loadAuditLog: (params?: { teamVaultId?: string; actions?: string[]; limit?: number; offset?: number }) => Promise<void>;

  // Invitation actions
  acceptInvitation: (invitationId: string) => Promise<void>;
  declineInvitation: (invitationId: string) => Promise<void>;

  // Vault role
  loadMyVaultRole: (vaultId: string) => Promise<void>;

  // Effective permission computation
  getEffectiveRole: (folderId?: string) => 'admin' | 'editor' | 'viewer' | null;
  canCreate: (folderId?: string) => boolean;
  canEdit: (folderId?: string) => boolean;
  canDelete: (folderId?: string) => boolean;
  canManagePermissions: () => boolean;

  // Folder permissions
  loadFolderPermissions: (vaultId: string) => Promise<void>;
  getFolderRole: (folderId: string) => 'admin' | 'editor' | 'viewer' | null;
  setFolderPermission: (vaultId: string, folderId: string, userId: string, role: 'admin' | 'editor' | 'viewer') => Promise<void>;
  removeFolderPermission: (vaultId: string, folderId: string, userId: string) => Promise<void>;
  listFolderPermissions: (vaultId: string, folderId: string) => Promise<FolderPermission[]>;

  // Reset
  reset: () => void;
}

export const useTeamStore = create<TeamStoreState>((set, get) => ({
  team: null,
  members: [],
  myRole: null,
  pendingInvitations: [],
  teamVaults: [],
  auditLog: [],
  isLoading: false,
  error: null,
  myVaultRole: null,
  folderPermissions: new Map(),
  permissionsUnconfigured: true,

  loadTeam: async () => {
    try {
      set({ isLoading: true, error: null });
      const [team, myRole] = await Promise.all([
        invoke<Team | null>('team_get'),
        invoke<'admin' | 'member' | null>('team_get_my_role'),
      ]);
      set({ team, myRole, isLoading: false });
    } catch (err) {
      console.error('[team] Failed to load team:', err);
      set({ isLoading: false, error: 'Failed to load team' });
    }
  },

  loadMembers: async () => {
    try {
      const members = await invoke<TeamMember[]>('team_get_members');
      set({ members });
    } catch (err) {
      console.error('[team] Failed to load members:', err);
    }
  },

  checkInvitations: async () => {
    try {
      const pendingInvitations = await invoke<TeamInvitation[]>('team_check_invitations');
      set({ pendingInvitations });
    } catch (err) {
      console.error('[team] Failed to check invitations:', err);
    }
  },

  loadTeamVaults: async () => {
    try {
      const teamVaults = await invoke<TeamVaultSummary[]>('team_vault_list');
      set({ teamVaults });
    } catch (err) {
      console.error('[team] Failed to load team vaults:', err);
    }
  },

  loadAuditLog: async (params) => {
    const { team } = get();
    if (!team) return;

    try {
      const auditLog = await invoke<AuditLogEntry[]>('team_audit_log', {
        teamId: team.id,
        ...params,
      });
      set({ auditLog });
    } catch (err) {
      console.error('[team] Failed to load audit log:', err);
    }
  },

  acceptInvitation: async (invitationId: string) => {
    try {
      set({ isLoading: true, error: null });
      await invoke('team_accept_invitation', { invitationId });
      // Reload everything after accepting
      const { pendingInvitations } = get();
      set({
        pendingInvitations: pendingInvitations.filter((i) => i.id !== invitationId),
        isLoading: false,
      });
      // Reload team data
      await get().loadTeam();
      await get().loadMembers();
      await get().loadTeamVaults();
    } catch (err) {
      console.error('[team] Failed to accept invitation:', err);
      set({ isLoading: false, error: 'Failed to accept invitation' });
    }
  },

  declineInvitation: async (invitationId: string) => {
    try {
      await invoke('team_decline_invitation', { invitationId });
      const { pendingInvitations } = get();
      set({
        pendingInvitations: pendingInvitations.filter((i) => i.id !== invitationId),
      });
    } catch (err) {
      console.error('[team] Failed to decline invitation:', err);
    }
  },

  // ── Vault role ──────────────────────────────────────────────

  loadMyVaultRole: async (vaultId: string) => {
    try {
      const members = await invoke<Array<{ user_id: string; role: string }>>('team_vault_list_members', { teamVaultId: vaultId });
      // Need current user ID — fetch from auth store indirectly via the returned list
      // The IPC returns all members; we find ourselves by checking auth
      const { user } = await import('./authStore').then(m => ({ user: m.useAuthStore.getState().user }));
      const me = members.find((m) => m.user_id === user?.id);
      set({ myVaultRole: (me?.role as 'admin' | 'editor' | 'viewer') ?? null });
    } catch (err) {
      console.error('[team] Failed to load vault role:', err);
      set({ myVaultRole: null });
    }
  },

  // ── Effective permission computation ──────────────────────

  getEffectiveRole: (folderId?: string) => {
    const { myVaultRole, folderPermissions, permissionsUnconfigured } = get();
    // Personal vault → always admin
    if (!myVaultRole) return null;
    // No folder specified or no overrides configured → vault role
    if (!folderId || permissionsUnconfigured) return myVaultRole;
    // Check folder override
    const folderRole = folderPermissions.get(folderId);
    if (!folderRole) return myVaultRole;
    // Restrict-only: return min(vault, folder)
    return minRole(myVaultRole, folderRole);
  },

  canCreate: (folderId?: string) => {
    const role = get().getEffectiveRole(folderId);
    return role === 'admin' || role === 'editor';
  },

  canEdit: (folderId?: string) => {
    const role = get().getEffectiveRole(folderId);
    return role === 'admin' || role === 'editor';
  },

  canDelete: (folderId?: string) => {
    const role = get().getEffectiveRole(folderId);
    return role === 'admin';
  },

  canManagePermissions: () => {
    const { myVaultRole } = get();
    return myVaultRole === 'admin';
  },

  // ── Folder permissions ──────────────────────────────────────

  loadFolderPermissions: async (vaultId: string) => {
    try {
      const perms = await invoke<FolderPermission[]>('team_vault_folder_permissions', { vaultId });
      const map = new Map<string, 'admin' | 'editor' | 'viewer'>();
      for (const p of perms) {
        map.set(p.folder_id, p.role);
      }
      set({
        folderPermissions: map,
        permissionsUnconfigured: perms.length === 0,
      });
    } catch (err) {
      console.error('[team] Failed to load folder permissions:', err);
      set({ folderPermissions: new Map(), permissionsUnconfigured: true });
    }
  },

  getFolderRole: (folderId: string) => {
    const { folderPermissions, permissionsUnconfigured } = get();
    if (permissionsUnconfigured) return 'admin'; // No permissions configured = full access
    return folderPermissions.get(folderId) ?? null;
  },

  setFolderPermission: async (vaultId: string, folderId: string, userId: string, role: 'admin' | 'editor' | 'viewer') => {
    try {
      await invoke('team_vault_set_folder_permission', { vaultId, folderId, userId, role });
      await get().loadFolderPermissions(vaultId);
    } catch (err) {
      console.error('[team] Failed to set folder permission:', err);
      throw err;
    }
  },

  removeFolderPermission: async (vaultId: string, folderId: string, userId: string) => {
    try {
      await invoke('team_vault_remove_folder_permission', { vaultId, folderId, userId });
      await get().loadFolderPermissions(vaultId);
    } catch (err) {
      console.error('[team] Failed to remove folder permission:', err);
      throw err;
    }
  },

  listFolderPermissions: async (vaultId: string, folderId: string) => {
    try {
      return await invoke<FolderPermission[]>('team_vault_list_folder_permissions', { vaultId, folderId });
    } catch (err) {
      console.error('[team] Failed to list folder permissions:', err);
      return [];
    }
  },

  reset: () => {
    set({
      team: null,
      members: [],
      myRole: null,
      pendingInvitations: [],
      teamVaults: [],
      auditLog: [],
      isLoading: false,
      error: null,
      myVaultRole: null,
      folderPermissions: new Map(),
      permissionsUnconfigured: true,
    });
  },
}));
