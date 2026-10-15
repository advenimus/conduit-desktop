import { tableSpec } from '../schema/tables.ts';
import { type Caller, Ctx } from './context.ts';
import { Engine } from './engine.ts';
import { ConflictError } from './errors.ts';
import type { Deps } from './handler.ts';
import { UnitOfWork } from './uow.ts';

const SERVICE: Caller = { role: 'service', uid: null, email: null };
const FREE_TIER = 'free';

async function inUnit<T>(deps: Deps, fn: (engine: Engine, ctx: Ctx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const uow = new UnitOfWork(deps.store, deps.now ? deps.now() : Date.now());
    const ctx = new Ctx(SERVICE, uow, deps.directory);
    try {
      const out = await fn(new Engine(ctx, deps.effects), ctx);
      await uow.commit();
      return out;
    } catch (e) {
      if (e instanceof ConflictError && attempt < 8) continue;
      throw e;
    }
  }
}

export interface NewUser {
  $id: string;
  email?: string;
  name?: string;
  prefs?: Record<string, unknown>;
}

/** handle_new_user: every account gets a Free profile. */
export async function userCreated(deps: Deps, user: NewUser): Promise<void> {
  await inUnit(deps, async (engine, ctx) => {
    const profiles = tableSpec('user_profiles');
    if (await ctx.uow.get(profiles, user.$id)) return;
    const free = await ctx.uow.first(tableSpec('tiers'), [{ column: 'name', op: 'eq', value: FREE_TIER }]);
    const fromPrefs = typeof user.prefs?.display_name === 'string' ? user.prefs.display_name : null;
    const displayName = fromPrefs || user.name || (user.email ?? '').split('@')[0] || null;
    await engine.insertRow(profiles, { id: user.$id, display_name: displayName, tier_id: free?.id ?? null });
  });
}

/** Deleting an Appwrite user replays the old ON DELETE rules for every table that pointed at auth.users. */
export async function userDeleted(deps: Deps, userId: string): Promise<void> {
  await inUnit(deps, (engine) => engine.forgetUser(userId));
}

const DAY = 86_400_000;

/** The two pg_cron jobs. */
export async function nightly(deps: Deps): Promise<Record<string, number>> {
  const now = deps.now ? deps.now() : Date.now();
  const counts: Record<string, number> = {};
  const purge = async (table: string, column: string, before: number) => {
    const spec = tableSpec(table);
    const rows = await deps.store.list(spec, [{ column, op: 'lt', value: new Date(before).toISOString() }]);
    for (let i = 0; i < rows.length; i += 90) {
      await inUnit(deps, async (engine) => {
        for (const r of rows.slice(i, i + 90)) await engine.deleteRow(spec, r);
      });
    }
    counts[table] = rows.length;
  };
  await purge('vault_audit_log', 'created_at', now - 730 * DAY);
  await purge('personal_vault_sessions', 'heartbeat_at', now - 30 * DAY);
  await purge('rate_limits', 'updated_at', now - DAY);
  return counts;
}
