import { tableSpec } from '../schema/tables.ts';
import { ApiError } from './errors.ts';
import type { Row } from './filters.ts';
import type { UnitOfWork } from './uow.ts';

export type Role = 'authenticated' | 'service' | 'anon';

export interface Caller {
  role: Role;
  uid: string | null;
  email: string | null;
  /** Looks the email up on first use when `email` was not known up front. */
  loadEmail?: () => Promise<string | null>;
  /** Client IP Appwrite saw, for the abuse check. */
  ip?: string | null;
}

/** Looks up users outside the database (Appwrite Users API, or a fake in tests). */
export interface Directory {
  exists(userId: string): Promise<boolean>;
  emails(userIds: readonly string[]): Promise<Map<string, string>>;
}

const T = {
  team_members: tableSpec('team_members'),
  team_vaults: tableSpec('team_vaults'),
  team_vault_members: tableSpec('team_vault_members'),
  user_profiles: tableSpec('user_profiles'),
  tiers: tableSpec('tiers'),
  app_config: tableSpec('app_config'),
};

/** The Postgres helper functions (is_team_member, is_team_vault_admin, ...) over one unit of work. */
export class Ctx {
  readonly caller: Caller;
  readonly uow: UnitOfWork;
  readonly directory: Directory;

  constructor(caller: Caller, uow: UnitOfWork, directory: Directory) {
    this.caller = caller;
    this.uow = uow;
    this.directory = directory;
  }

  /** SECURITY DEFINER: same caller identity, but row rules and user-only guards no longer apply. */
  definer(): Ctx {
    return new Ctx({ ...this.caller, role: 'service' }, this.uow, this.directory);
  }

  private emailLookup: Promise<string | null> | null = null;

  /** auth.email() */
  callerEmail(): Promise<string | null> {
    if (this.caller.email !== null || !this.caller.loadEmail) return Promise.resolve(this.caller.email);
    return (this.emailLookup ??= this.caller.loadEmail());
  }

  get uid(): string | null {
    return this.caller.uid;
  }

  get isService(): boolean {
    return this.caller.role === 'service';
  }

  /** auth.uid() for user-only paths; 28000 when signed out. */
  requireUid(): string {
    if (!this.caller.uid) throw new ApiError('28000', 'not authenticated');
    return this.caller.uid;
  }

  async teamRole(teamId: unknown, userId: unknown): Promise<string | null> {
    if (typeof teamId !== 'string' || typeof userId !== 'string') return null;
    const m = await this.uow.first(T.team_members, [
      { column: 'team_id', op: 'eq', value: teamId },
      { column: 'user_id', op: 'eq', value: userId },
    ]);
    return (m?.role as string | undefined) ?? null;
  }

  async isTeamMember(teamId: unknown, userId: unknown): Promise<boolean> {
    return (await this.teamRole(teamId, userId)) !== null;
  }

  async isTeamAdmin(teamId: unknown, userId: unknown): Promise<boolean> {
    return (await this.teamRole(teamId, userId)) === 'admin';
  }

  async teamVault(vaultId: unknown): Promise<Row | null> {
    return typeof vaultId === 'string' ? this.uow.get(T.team_vaults, vaultId) : null;
  }

  /** Vault role, only while the user is still on the vault's team (like is_team_vault_member). */
  async vaultRole(vaultId: unknown, userId: unknown): Promise<string | null> {
    if (typeof vaultId !== 'string' || typeof userId !== 'string') return null;
    const m = await this.uow.first(T.team_vault_members, [
      { column: 'team_vault_id', op: 'eq', value: vaultId },
      { column: 'user_id', op: 'eq', value: userId },
    ]);
    if (!m) return null;
    const vault = await this.teamVault(vaultId);
    if (!vault || !(await this.isTeamMember(vault.team_id, userId))) return null;
    return m.role as string;
  }

  /** The bare team_vault_members role, without the team check (old RLS policies that join directly). */
  async rawVaultRole(vaultId: unknown, userId: unknown): Promise<string | null> {
    if (typeof vaultId !== 'string' || typeof userId !== 'string') return null;
    const m = await this.uow.first(T.team_vault_members, [
      { column: 'team_vault_id', op: 'eq', value: vaultId },
      { column: 'user_id', op: 'eq', value: userId },
    ]);
    return (m?.role as string | undefined) ?? null;
  }

  async isVaultMember(vaultId: unknown, userId: unknown): Promise<boolean> {
    return (await this.vaultRole(vaultId, userId)) !== null;
  }

  async isVaultAdmin(vaultId: unknown, userId: unknown): Promise<boolean> {
    return (await this.vaultRole(vaultId, userId)) === 'admin';
  }

  async vaultHasMembers(vaultId: unknown): Promise<boolean> {
    if (typeof vaultId !== 'string') return false;
    return this.uow.exists(T.team_vault_members, [{ column: 'team_vault_id', op: 'eq', value: vaultId }]);
  }

  async sharesTeamAsAdmin(adminId: unknown, memberId: unknown): Promise<boolean> {
    if (typeof adminId !== 'string' || typeof memberId !== 'string') return false;
    const adminTeams = await this.uow.list(T.team_members, [
      { column: 'user_id', op: 'eq', value: adminId },
      { column: 'role', op: 'eq', value: 'admin' },
    ]);
    for (const t of adminTeams) {
      if (await this.isTeamMember(t.team_id, memberId)) return true;
    }
    return false;
  }

  async profile(userId: unknown): Promise<Row | null> {
    return typeof userId === 'string' ? this.uow.get(T.user_profiles, userId) : null;
  }

  async tierOf(userId: unknown): Promise<Row | null> {
    const p = await this.profile(userId);
    return p?.tier_id ? this.uow.get(T.tiers, p.tier_id as string) : null;
  }

  async configValue(key: string): Promise<unknown> {
    const r = await this.uow.get(T.app_config, key);
    return r ? r.value : undefined;
  }

  async configInt(key: string, fallback: number): Promise<number> {
    const v = await this.configValue(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
  }
}
