import { createHash } from 'node:crypto';
import { tableSpec } from '../../schema/tables.ts';
import type { Ctx } from '../context.ts';
import type { Engine } from '../engine.ts';
import { ApiError } from '../errors.ts';

const LIMITS = tableSpec('rate_limits');

/** Service only: counts one attempt against `p_key` in a fixed window and says whether it is allowed. */
export async function rateLimitHit(ctx: Ctx, engine: Engine, args: Record<string, unknown>): Promise<{ allowed: boolean; remaining: number; retry_after: number }> {
  if (!ctx.isService) throw new ApiError('42501', 'permission denied for function rate_limit_hit');
  const raw = args.p_key;
  const limit = Number(args.p_limit);
  const windowSeconds = Number(args.p_window_seconds);
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) throw new ApiError('22023', 'p_key must be a non-empty string');
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new ApiError('22023', 'p_limit and p_window_seconds must be positive integers (window at most a day)');
  }
  const key = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  await ctx.uow.guard(`rl:${key}`);
  const now = ctx.uow.now;
  const row = await ctx.uow.get(LIMITS, key);
  const windowEnd = row ? Date.parse(row.window_start as string) + windowSeconds * 1000 : 0;
  let hits: number;
  let resetAt: number;
  if (!row || windowEnd <= now) {
    hits = 1;
    resetAt = now + windowSeconds * 1000;
    const fresh = { key, window_start: new Date(now).toISOString(), hits, updated_at: new Date(now).toISOString() };
    if (row) await engine.updateRow(LIMITS, row, fresh);
    else await engine.insertRow(LIMITS, fresh);
  } else {
    hits = Number(row.hits) + 1;
    resetAt = windowEnd;
    await engine.updateRow(LIMITS, row, { hits, updated_at: new Date(now).toISOString() });
  }
  const allowed = hits <= limit;
  return { allowed, remaining: Math.max(0, limit - hits), retry_after: allowed ? 0 : Math.ceil((resetAt - now) / 1000) };
}
