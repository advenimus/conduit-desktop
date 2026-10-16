import { tableSpec } from '../../schema/tables.ts';
import { coerce } from '../codec.ts';
import type { Ctx } from '../context.ts';
import type { Engine } from '../engine.ts';
import { ApiError } from '../errors.ts';
import type { Row } from '../filters.ts';
import { folderRole } from '../policies.ts';

const ENTRIES = tableSpec('vault_entries');
const MEMBERS = tableSpec('team_members');

type Json = Record<string, unknown>;

const arg = (args: Json, name: string, column: string): unknown => {
  const v = args[`p_${name}`];
  return v === undefined ? null : coerce(ENTRIES, column, v);
};

/** public.upsert_vault_entry_versioned. engine runs as definer; ctx is the caller. */
export async function upsertVaultEntryVersioned(ctx: Ctx, engine: Engine, args: Json): Promise<Json[]> {
  const uid = ctx.requireUid();
  const id = arg(args, 'id', 'id') as string | null;
  const vaultId = arg(args, 'vault_id', 'vault_id') as string | null;
  if (!id || !vaultId) throw new ApiError('23502', 'null value in column "id" of relation "vault_entries" violates not-null constraint');
  await ctx.uow.guard(`vault:${vaultId}`);

  const role = await ctx.vaultRole(vaultId, uid);
  if (role !== 'admin' && role !== 'editor') throw new ApiError('42501', 'not allowed to edit this vault');

  const existing = await ctx.uow.get(ENTRIES, id);
  const current = existing && existing.vault_id === vaultId ? existing : null;
  const folderId = arg(args, 'folder_id', 'folder_id');
  const writable = async (f: unknown) => {
    const r = (await folderRole(ctx, vaultId, f, uid)) ?? 'viewer';
    return r === 'admin' || r === 'editor';
  };
  if (
    (folderId !== null && !(await writable(folderId))) ||
    (current && current.folder_id !== null && current.folder_id !== folderId && !(await writable(current.folder_id)))
  ) {
    throw new ApiError('42501', 'not allowed to edit this folder');
  }

  const now = ctx.uow.nowIso();
  const fields: Row = {
    name: arg(args, 'name', 'name'),
    entry_type: arg(args, 'entry_type', 'entry_type'),
    folder_id: folderId,
    parent_entry_id: arg(args, 'parent_entry_id', 'parent_entry_id'),
    sort_order: args.p_sort_order === undefined ? 0 : arg(args, 'sort_order', 'sort_order'),
    host: arg(args, 'host', 'host'),
    port: arg(args, 'port', 'port'),
    username: arg(args, 'username', 'username'),
    domain: arg(args, 'domain', 'domain'),
    icon: arg(args, 'icon', 'icon'),
    color: arg(args, 'color', 'color'),
    notes: arg(args, 'notes', 'notes'),
    password_encrypted: arg(args, 'password_encrypted', 'password_encrypted'),
    private_key_encrypted: arg(args, 'private_key_encrypted', 'private_key_encrypted'),
    config_encrypted: arg(args, 'config_encrypted', 'config_encrypted'),
    tags_encrypted: arg(args, 'tags_encrypted', 'tags_encrypted'),
    is_favorite: args.p_is_favorite === undefined ? false : arg(args, 'is_favorite', 'is_favorite'),
    updated_by: uid,
    credential_type: arg(args, 'credential_type', 'credential_type'),
    totp_secret_encrypted: arg(args, 'totp_secret_encrypted', 'totp_secret_encrypted'),
    updated_at: now,
  };

  if (!current) {
    if (existing) throw new ApiError('23505', 'duplicate key value violates unique constraint "vault_entries_pkey"');
    await engine.insertRow(ENTRIES, { id, vault_id: vaultId, ...fields, version: 1, created_at: now });
    return [{ success: true, current_version: 1 }];
  }
  const next = Number(current.version) + 1;
  await engine.updateRow(ENTRIES, current, { ...fields, version: next });
  return [{ success: true, current_version: next }];
}

/** public.get_team_members_with_email */
export async function teamMembersWithEmail(ctx: Ctx, args: Json): Promise<Json[]> {
  const teamId = args.p_team_id === undefined || args.p_team_id === null ? null : (coerce(MEMBERS, 'team_id', args.p_team_id) as string);
  if (!teamId || !(await ctx.isTeamMember(teamId, ctx.uid))) return [];
  const members = (await ctx.uow.list(MEMBERS, [{ column: 'team_id', op: 'eq', value: teamId }])).sort(
    (a, b) => Date.parse(String(a.joined_at)) - Date.parse(String(b.joined_at)),
  );
  const emails = await ctx.directory.emails(members.map((m) => m.user_id as string));
  const out: Json[] = [];
  for (const m of members) {
    const email = emails.get(m.user_id as string);
    if (email === undefined) continue;
    const profile = await ctx.profile(m.user_id);
    out.push({
      id: m.id, team_id: m.team_id, user_id: m.user_id, role: m.role, joined_at: m.joined_at,
      user_email: email, user_display_name: (profile?.display_name as string | null | undefined) ?? null,
    });
  }
  return out;
}
