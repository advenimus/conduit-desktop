import { type Caller, Ctx, type Directory } from './context.ts';
import { Engine, type QueryRequest } from './engine.ts';
import { ApiError, ConflictError } from './errors.ts';
import { Sessions } from './rpc/sessions.ts';
import { rateLimitHit } from './rpc/rate-limit.ts';
import { submitFingerprint } from './rpc/fingerprint.ts';
import { teamMembersWithEmail, upsertVaultEntryVersioned } from './rpc/team.ts';
import { type FileStore, Storage, type StorageRequest } from './storage.ts';
import type { Store } from './store.ts';
import type { Effects } from './triggers.ts';
import { UnitOfWork } from './uow.ts';

export type ApiRequest =
  | ({ kind: 'query' } & QueryRequest)
  | { kind: 'rpc'; fn: string; args?: Record<string, unknown> }
  | ({ kind: 'storage' } & StorageRequest);

export interface ApiResponse {
  status: number;
  body: { data: unknown; count?: number | null; error: { code: string; message: string; details: string | null; hint: string | null } | null };
}

export interface Deps {
  store: Store;
  files: FileStore;
  directory: Directory;
  effects: Effects;
  now?: () => number;
  /** Abuse scoring on fingerprints. Off only on the local stack, where every test account shares one Mac. */
  abuseChecks?: boolean;
}

const MAX_ATTEMPTS = 8;

type Rpc = (ctx: Ctx, args: Record<string, unknown>, fx: Effects, deps: Deps) => Promise<unknown>;

const sessions = (ctx: Ctx, fx: Effects) => new Sessions(ctx, new Engine(ctx.definer(), fx));

const RPCS: Record<string, Rpc> = {
  vault_session_peek: (ctx, a, fx) => sessions(ctx, fx).peek(a),
  vault_session_acquire: (ctx, a, fx) => sessions(ctx, fx).acquire(a),
  vault_session_heartbeat: (ctx, a, fx) => sessions(ctx, fx).heartbeat(a),
  vault_session_release: (ctx, a, fx) => sessions(ctx, fx).release(a),
  vault_session_abandon: (ctx, a, fx) => sessions(ctx, fx).abandon(a),
  vault_owner_release: (ctx, a, fx) => sessions(ctx, fx).ownerRelease(a),
  upsert_vault_entry_versioned: (ctx, a, fx) => upsertVaultEntryVersioned(ctx, new Engine(ctx.definer(), fx), a),
  get_team_members_with_email: (ctx, a) => teamMembersWithEmail(ctx, a),
  submit_fingerprint: (ctx, a, fx, deps) => submitFingerprint(ctx, new Engine(ctx.definer(), fx), a, deps.abuseChecks !== false),
  rate_limit_hit: (ctx, a, fx) => rateLimitHit(ctx, new Engine(ctx.definer(), fx), a),
};

async function once(req: ApiRequest, caller: Caller, deps: Deps): Promise<{ data: unknown; count: number | null }> {
  const uow = new UnitOfWork(deps.store, deps.now ? deps.now() : Date.now());
  const ctx = new Ctx(caller, uow, deps.directory);
  let result: { data: unknown; count: number | null };
  if (req.kind === 'query') {
    result = await new Engine(ctx, deps.effects).query(req);
  } else if (req.kind === 'rpc') {
    const fn = RPCS[req.fn];
    if (!fn) throw new ApiError('PGRST202', `Could not find the function public.${String(req.fn)} in the schema cache`, 404);
    if (caller.role === 'anon' && req.fn !== 'vault_session_peek') throw new ApiError('28000', 'not authenticated');
    result = { data: (await fn(ctx, req.args ?? {}, deps.effects, deps)) ?? null, count: null };
  } else if (req.kind === 'storage') {
    result = { data: await new Storage(ctx, new Engine(ctx.definer(), deps.effects), deps.files).run(req), count: null };
  } else {
    throw new ApiError('PGRST100', 'unknown request kind');
  }
  await uow.commit();
  return result;
}

export async function handle(req: ApiRequest, caller: Caller, deps: Deps): Promise<ApiResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { data, count } = await once(req, caller, deps);
      return { status: 200, body: { data, count, error: null } };
    } catch (e) {
      if (e instanceof ConflictError && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.random() * 25 * attempt));
        continue;
      }
      if (e instanceof ApiError) return { status: e.status, body: { data: null, error: e.toJSON() } };
      if (e instanceof ConflictError) {
        return { status: 409, body: { data: null, error: { code: '40001', message: 'could not serialize access due to concurrent update', details: null, hint: null } } };
      }
      console.error('[api] unexpected error:', e);
      return { status: 500, body: { data: null, error: { code: 'XX000', message: 'internal error', details: null, hint: null } } };
    }
  }
}
