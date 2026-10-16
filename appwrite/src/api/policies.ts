import { tableSpec } from '../schema/tables.ts';
import type { Ctx } from './context.ts';
import type { Row } from './filters.ts';

// Port of the prod RLS policies (pg_policies, 2026-10-14). A missing entry means no policy for that
// command, which Postgres treats as "deny" for signed-in users. The service caller skips all of this.

type Check = (row: Row, ctx: Ctx) => Promise<boolean>;

export interface TablePolicy {
  select?: Check;
  insert?: Check;
  /** UPDATE ... USING, on the existing row. */
  update?: Check;
  /** UPDATE ... WITH CHECK, on the new row. Postgres reuses USING when a policy has none. */
  updateCheck?: Check;
  delete?: Check;
}

const RANK: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };
const rank = (role: string | null | undefined): number => (role ? (RANK[role] ?? 1) : 1);
const own = (column: string): Check => async (row, ctx) => ctx.uid !== null && row[column] === ctx.uid;
const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);

/** public.user_can_access_folder: the folder grant (or the nearest ancestor's) can only lower the vault role. */
export async function folderRole(ctx: Ctx, vaultId: unknown, folderId: unknown, userId: unknown): Promise<string | null> {
  const vaultRole = await ctx.rawVaultRole(vaultId, userId);
  if (vaultRole === null) return null;
  const perms = tableSpec('vault_folder_permissions');
  const folders = tableSpec('vault_folders');
  const grant = async (fid: unknown) =>
    typeof fid === 'string'
      ? ((await ctx.uow.first(perms, [
          { column: 'vault_id', op: 'eq', value: vaultId },
          { column: 'folder_id', op: 'eq', value: fid },
          { column: 'user_id', op: 'eq', value: userId },
        ]))?.role as string | undefined) ?? null
      : null;
  let role = await grant(folderId);
  if (role === null && typeof folderId === 'string') {
    const seen = new Set<string>([folderId]);
    const start = await ctx.uow.get(folders, folderId);
    let parent = start && start.vault_id === vaultId ? (start.parent_id as string | null) : null;
    while (parent && !seen.has(parent) && role === null) {
      seen.add(parent);
      role = await grant(parent);
      if (role !== null) break;
      parent = ((await ctx.uow.get(folders, parent))?.parent_id as string | null) ?? null;
    }
  }
  if (role === null) return vaultRole;
  return rank(role) < rank(vaultRole) ? role : vaultRole;
}

/** public.team_vault_folder_writable */
export async function folderWritable(ctx: Ctx, vaultId: unknown, folderId: unknown): Promise<boolean> {
  if (folderId === null || folderId === undefined) return true;
  const role = (await folderRole(ctx, vaultId, folderId, ctx.uid)) ?? 'viewer';
  return role === 'admin' || role === 'editor';
}

const vaultEditor = async (vaultId: unknown, ctx: Ctx) => {
  const role = await ctx.rawVaultRole(vaultId, ctx.uid);
  return role === 'admin' || role === 'editor';
};

export const POLICIES: Record<string, TablePolicy> = {
  tiers: {
    select: async (_row, ctx) => ctx.caller.role === 'authenticated',
  },
  user_profiles: {
    select: own('id'),
    update: own('id'),
  },
  teams: {
    select: async (row, ctx) => ctx.isTeamMember(row.id, ctx.uid),
    update: own('owner_id'),
  },
  team_members: {
    select: async (row, ctx) => ctx.isTeamMember(row.team_id, ctx.uid),
    update: async (row, ctx) => ctx.isTeamAdmin(row.team_id, ctx.uid),
    delete: async (row, ctx) => (await ctx.isTeamAdmin(row.team_id, ctx.uid)) && row.user_id !== ctx.uid,
  },
  team_invitations: {
    select: async (row, ctx) =>
      (await ctx.isTeamAdmin(row.team_id, ctx.uid)) || (lower(row.email) !== null && lower(row.email) === lower(await ctx.callerEmail())),
    update: async (row, ctx) =>
      (await ctx.isTeamAdmin(row.team_id, ctx.uid)) || (lower(row.email) !== null && lower(row.email) === lower(await ctx.callerEmail())),
  },
  team_vaults: {
    select: async (row, ctx) => ctx.isTeamMember(row.team_id, ctx.uid),
    insert: async (row, ctx) => row.created_by === ctx.uid && (await ctx.isTeamAdmin(row.team_id, ctx.uid)),
    update: async (row, ctx) => ctx.isTeamAdmin(row.team_id, ctx.uid),
    delete: async (row, ctx) => ctx.isTeamAdmin(row.team_id, ctx.uid),
  },
  team_vault_members: {
    select: async (row, ctx) => row.user_id === ctx.uid || (await ctx.isVaultMember(row.team_vault_id, ctx.uid)),
    insert: async (row, ctx) => {
      const vault = await ctx.teamVault(row.team_vault_id);
      if (!vault || !(await ctx.isTeamMember(vault.team_id, row.user_id))) return false;
      if (await ctx.isVaultAdmin(row.team_vault_id, ctx.uid)) return true;
      return (
        !(await ctx.vaultHasMembers(row.team_vault_id)) &&
        row.user_id === ctx.uid &&
        row.role === 'admin' &&
        vault.created_by === ctx.uid &&
        (await ctx.isTeamAdmin(vault.team_id, ctx.uid))
      );
    },
    update: async (row, ctx) => ctx.isVaultAdmin(row.team_vault_id, ctx.uid),
    delete: async (row, ctx) => ctx.isVaultAdmin(row.team_vault_id, ctx.uid),
  },
  vault_key_wraps: {
    select: async (row, ctx) => row.user_id === ctx.uid || (await ctx.isVaultAdmin(row.team_vault_id, ctx.uid)),
    insert: async (row, ctx) => {
      if (!(await ctx.isVaultAdmin(row.team_vault_id, ctx.uid))) return false;
      const vault = await ctx.teamVault(row.team_vault_id);
      return vault !== null && (await ctx.isTeamMember(vault.team_id, row.user_id));
    },
    delete: async (row, ctx) => ctx.isVaultAdmin(row.team_vault_id, ctx.uid),
  },
  vault_entries: {
    select: async (row, ctx) => (await ctx.rawVaultRole(row.vault_id, ctx.uid)) !== null,
    insert: async (row, ctx) =>
      (await vaultEditor(row.vault_id, ctx)) && row.updated_by === ctx.uid && (await folderWritable(ctx, row.vault_id, row.folder_id)),
    update: async (row, ctx) => (await vaultEditor(row.vault_id, ctx)) && (await folderWritable(ctx, row.vault_id, row.folder_id)),
    updateCheck: async (row, ctx) =>
      (await vaultEditor(row.vault_id, ctx)) && row.updated_by === ctx.uid && (await folderWritable(ctx, row.vault_id, row.folder_id)),
    delete: async (row, ctx) => (await ctx.rawVaultRole(row.vault_id, ctx.uid)) === 'admin',
  },
  vault_folders: {
    select: async (row, ctx) => (await ctx.rawVaultRole(row.vault_id, ctx.uid)) !== null,
    insert: async (row, ctx) => vaultEditor(row.vault_id, ctx),
    update: async (row, ctx) => vaultEditor(row.vault_id, ctx),
    delete: async (row, ctx) => (await ctx.rawVaultRole(row.vault_id, ctx.uid)) === 'admin',
  },
  vault_folder_permissions: {
    select: async (row, ctx) => ctx.isVaultMember(row.vault_id, ctx.uid),
    insert: async (row, ctx) => ctx.isVaultAdmin(row.vault_id, ctx.uid),
    update: async (row, ctx) => ctx.isVaultAdmin(row.vault_id, ctx.uid),
    delete: async (row, ctx) => ctx.isVaultAdmin(row.vault_id, ctx.uid),
  },
  vault_password_history: {
    select: async (row, ctx) => ctx.isVaultMember(row.vault_id, ctx.uid),
    insert: async (row, ctx) => (await ctx.isVaultMember(row.vault_id, ctx.uid)) && (await vaultEditor(row.vault_id, ctx)),
    update: async (row, ctx) => (await ctx.isVaultMember(row.vault_id, ctx.uid)) && (await vaultEditor(row.vault_id, ctx)),
    delete: async (row, ctx) => ctx.isVaultAdmin(row.vault_id, ctx.uid),
  },
  vault_audit_log: {
    select: async (row, ctx) => ctx.isTeamAdmin(row.team_id, ctx.uid),
    insert: async (row, ctx) => row.actor_id === ctx.uid && (await ctx.isTeamMember(row.team_id, ctx.uid)),
  },
  vault_locks: {
    select: async (row, ctx) => (await ctx.rawVaultRole(row.vault_id, ctx.uid)) !== null,
    insert: own('locked_by'),
    update: own('locked_by'),
    delete: async (row, ctx) =>
      row.locked_by === ctx.uid || (typeof row.expires_at === 'string' && Date.parse(row.expires_at) < ctx.uow.now),
  },
  user_public_keys: {
    select: async (row, ctx) => row.user_id === ctx.uid || (await ctx.sharesTeamAsAdmin(ctx.uid, row.user_id)),
    insert: own('user_id'),
    update: own('user_id'),
    delete: own('user_id'),
  },
  user_key_backups: {
    select: own('user_id'),
    insert: own('user_id'),
    update: own('user_id'),
  },
  device_auth_requests: {
    select: own('user_id'),
    insert: own('user_id'),
    update: own('user_id'),
  },
  feedback_submissions: {
    select: own('user_id'),
    insert: own('user_id'),
  },
  personal_vault_sessions: {
    select: own('user_id'),
  },
  personal_vault_owners: {
    select: own('owner_id'),
  },
};

export function policyFor(table: string): TablePolicy {
  return POLICIES[table] ?? {};
}
