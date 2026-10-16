import { tableSpec } from '../schema/tables.ts';
import type { Ctx } from './context.ts';
import { ApiError } from './errors.ts';
import type { Row } from './filters.ts';

// Port of the prod triggers (pg_trigger, 2026-10-14). BEFORE hooks may change the row or throw;
// AFTER hooks run inside the same unit of work, so their writes commit together with the statement.

/** Things that happen outside the database once the write has committed. */
export interface Effects {
  syncVaultMembership(vaultId: string, userId: string, role: string | null): Promise<void>;
  newUserProfile(userId: string): Promise<void>;
  feedbackSubmitted(row: Row): Promise<void>;
  /** Bytes of a cloud_files row that is gone (removed, replaced, or its owner deleted). */
  fileReleased(bucket: string, fileId: string): Promise<void>;
}

export interface Hooks {
  beforeInsert?: (row: Row, ctx: Ctx) => Promise<Row>;
  beforeUpdate?: (oldRow: Row, newRow: Row, ctx: Ctx) => Promise<Row>;
  afterInsert?: (row: Row, ctx: Ctx, fx: Effects) => Promise<void>;
  afterUpdate?: (oldRow: Row, newRow: Row, ctx: Ctx, fx: Effects) => Promise<void>;
  afterDelete?: (row: Row, ctx: Ctx, fx: Effects) => Promise<void>;
}

/** Guard scopes taken before a write, so count-based rules can't be raced. */
export function insertScopes(table: string, row: Row): string[] {
  if (table === 'team_members' && typeof row.team_id === 'string') return [`team:${row.team_id}`];
  return [];
}

const changed = (a: Row, b: Row, cols: readonly string[]) => cols.some((c) => JSON.stringify(a[c] ?? null) !== JSON.stringify(b[c] ?? null));
const isUserRole = (ctx: Ctx) => ctx.caller.role === 'authenticated' || ctx.caller.role === 'anon';
const VAULT_RANK: Record<string, number> = { admin: 3, editor: 2 };

async function restrictOnly(row: Row, ctx: Ctx): Promise<Row> {
  const vaultRole = await ctx.rawVaultRole(row.vault_id, row.user_id);
  if ((VAULT_RANK[String(row.role)] ?? 1) > (VAULT_RANK[vaultRole ?? ''] ?? 1)) {
    throw new ApiError('P0001', 'Folder permission cannot exceed vault role');
  }
  return row;
}

async function syncIsTeamMember(userId: unknown, ctx: Ctx): Promise<void> {
  if (typeof userId !== 'string') return;
  const profiles = tableSpec('user_profiles');
  const profile = await ctx.uow.get(profiles, userId);
  if (!profile) return;
  const member = await ctx.uow.exists(tableSpec('team_members'), [{ column: 'user_id', op: 'eq', value: userId }]);
  if (profile.is_team_member !== member) ctx.uow.stage('update', profiles, { ...profile, is_team_member: member }, undefined, profile);
}

export const HOOKS: Record<string, Hooks> = {
  team_members: {
    beforeInsert: async (row, ctx) => {
      const team = await ctx.uow.get(tableSpec('teams'), String(row.team_id));
      if (!team) throw new ApiError('23503', 'team not found');
      if (team.stripe_subscription_id === null) throw new ApiError('23514', 'team_inactive: this team has no active plan');
      const count = (await ctx.uow.list(tableSpec('team_members'), [{ column: 'team_id', op: 'eq', value: row.team_id }])).length;
      if (count >= Number(team.max_seats)) throw new ApiError('23514', `team_full: all ${String(team.max_seats)} seats are in use`);
      return row;
    },
    beforeUpdate: async (oldRow, newRow) => {
      if (changed(oldRow, newRow, ['id', 'team_id', 'user_id'])) throw new ApiError('42501', 'a team member row cannot move');
      return newRow;
    },
    afterInsert: async (row, ctx) => syncIsTeamMember(row.user_id, ctx),
    afterDelete: async (row, ctx, fx) => {
      await syncIsTeamMember(row.user_id, ctx);
      // cleanup_removed_team_member: drop the user's vault rights in this team and flag key rotation.
      const vaults = await ctx.uow.list(tableSpec('team_vaults'), [{ column: 'team_id', op: 'eq', value: row.team_id }]);
      const vaultIds = vaults.map((v) => v.id as string);
      if (vaultIds.length === 0) return;
      const byUser = (column: string) => [
        { column, op: 'in' as const, value: vaultIds },
        { column: 'user_id', op: 'eq' as const, value: row.user_id },
      ];
      for (const p of await ctx.uow.list(tableSpec('vault_folder_permissions'), byUser('vault_id'))) {
        ctx.uow.stage('delete', tableSpec('vault_folder_permissions'), p);
      }
      for (const w of await ctx.uow.list(tableSpec('vault_key_wraps'), byUser('team_vault_id'))) {
        ctx.uow.stage('delete', tableSpec('vault_key_wraps'), w);
      }
      const gone = await ctx.uow.list(tableSpec('team_vault_members'), byUser('team_vault_id'));
      for (const m of gone) {
        ctx.uow.stage('delete', tableSpec('team_vault_members'), m);
        ctx.uow.afterCommit(() => fx.syncVaultMembership(m.team_vault_id as string, m.user_id as string, null));
      }
      for (const v of vaults.filter((v) => gone.some((m) => m.team_vault_id === v.id))) {
        ctx.uow.stage('update', tableSpec('team_vaults'), { ...v, rotation_pending: true, updated_at: ctx.uow.nowIso() }, undefined, v);
      }
    },
  },
  teams: {
    beforeUpdate: async (oldRow, newRow, ctx) => {
      if (isUserRole(ctx) && changed(oldRow, newRow, ['id', 'slug', 'owner_id', 'max_seats', 'stripe_subscription_id', 'stripe_customer_id', 'created_at'])) {
        throw new ApiError('42501', 'protected column');
      }
      return newRow;
    },
  },
  user_profiles: {
    beforeUpdate: async (oldRow, newRow, ctx) => {
      if (
        isUserRole(ctx) &&
        (changed(oldRow, newRow, [
          'tier_id', 'is_team_member', 'subscription_status', 'subscription_period_end', 'cancel_at_period_end',
          'trial_ends_at', 'has_used_trial', 'stripe_subscription_id', 'abuse_score', 'is_suspended',
          'suspended_reason', 'registration_ip', 'registration_fingerprint',
        ]) ||
          (changed(oldRow, newRow, ['stripe_customer_id']) && oldRow.stripe_customer_id !== null))
      ) {
        throw new ApiError('42501', 'protected column');
      }
      return newRow;
    },
    afterInsert: async (row, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.newUserProfile(row.id as string));
    },
  },
  team_invitations: {
    beforeUpdate: async (oldRow, newRow, ctx) => {
      if (ctx.caller.role !== 'authenticated') return newRow;
      if (changed(oldRow, newRow, ['team_id', 'id'])) throw new ApiError('42501', 'an invitation cannot move to another team');
      if (await ctx.isTeamAdmin(oldRow.team_id, ctx.uid)) {
        if (
          Date.parse(String(newRow.expires_at)) > Date.parse(String(oldRow.expires_at)) ||
          changed(oldRow, newRow, ['token']) ||
          (oldRow.status !== 'pending' && newRow.status === 'pending')
        ) {
          throw new ApiError('42501', 'an invitation cannot be extended or reopened');
        }
        return newRow;
      }
      if (changed(oldRow, newRow, ['email', 'invited_by', 'role', 'token', 'expires_at', 'created_at'])) {
        throw new ApiError('42501', 'only the invitation status can be changed');
      }
      if (oldRow.status !== 'pending' || !['accepted', 'declined'].includes(String(newRow.status))) {
        throw new ApiError('42501', 'only a pending invitation can be accepted or declined');
      }
      return newRow;
    },
  },
  team_vault_members: {
    beforeUpdate: async (oldRow, newRow) => {
      if (changed(oldRow, newRow, ['id', 'team_vault_id', 'user_id'])) throw new ApiError('42501', 'a team vault member row cannot move');
      return newRow;
    },
    afterInsert: async (row, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.syncVaultMembership(row.team_vault_id as string, row.user_id as string, row.role as string));
    },
    afterUpdate: async (_oldRow, newRow, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.syncVaultMembership(newRow.team_vault_id as string, newRow.user_id as string, newRow.role as string));
    },
    afterDelete: async (row, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.syncVaultMembership(row.team_vault_id as string, row.user_id as string, null));
    },
  },
  vault_folder_permissions: {
    beforeInsert: restrictOnly,
    beforeUpdate: async (_oldRow, newRow, ctx) => restrictOnly(newRow, ctx),
  },
  personal_vault_owners: {
    beforeUpdate: async (oldRow, newRow, ctx) => {
      if (newRow.owner_id === null && oldRow.owner_id !== null) {
        return { ...newRow, owner_since: null, released_at: newRow.released_at ?? ctx.uow.nowIso(), updated_at: ctx.uow.nowIso() };
      }
      return newRow;
    },
  },
  cloud_files: {
    afterUpdate: async (oldRow, newRow, ctx, fx) => {
      if (oldRow.file_id !== newRow.file_id) ctx.uow.afterCommit(() => fx.fileReleased(oldRow.bucket as string, oldRow.file_id as string));
    },
    afterDelete: async (row, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.fileReleased(row.bucket as string, row.file_id as string));
    },
  },
  feedback_submissions: {
    afterInsert: async (row, ctx, fx) => {
      ctx.uow.afterCommit(() => fx.feedbackSubmitted(row));
    },
  },
};

export function hooksFor(table: string): Hooks {
  return HOOKS[table] ?? {};
}
