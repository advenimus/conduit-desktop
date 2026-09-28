/**
 * Effective device limit (spec 6.8, 2.2 last deviation, 12 rows 35/62): the server's limit when
 * the lease is confirmed; otherwise, when signed in, the last server limit for this vault from
 * local.json, else the cached tier value, each only when at most 7 days old AND not dated more
 * than 5 minutes in the future; otherwise 1. Signed out and local mode: 1. -1 means unlimited.
 * A sane cached Pro value may raise the offline limit for up to 7 days (documented deviation).
 * Also the 6.8 environment rule: packaged builds ignore CONDUIT_ENV. Pure.
 */

import type { CachedTierLimit } from './host.js';

/** 6.8: cached values older than 7 days are ignored. */
export const LIMIT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 6.8: timestamps more than 5 minutes in the future are rejected. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const UNLIMITED = -1;
export const FREE_LIMIT = 1;
/**
 * 6.8: a limit the server keeps confirming is re-dated in local.json at most this often, so it
 * never ages out while the device is online, without a local.json write on every heartbeat.
 */
export const LAST_LIMIT_REFRESH_MS = 60 * 60 * 1000;

export type LimitSource = 'server' | 'local-json' | 'tier-cache' | 'default';

export interface LimitInputs {
  readonly signedIn: boolean;
  /** LeaseTracker.isConfirmed(now). */
  readonly confirmed: boolean;
  readonly serverLimit: number | null;
  /** local.json lastLimit. */
  readonly localLast: { readonly value: number; readonly atMs: number } | null;
  readonly tierCache: CachedTierLimit | null;
  readonly nowMs: number;
}

export interface EffectiveLimit {
  readonly limit: number;
  readonly source: LimitSource;
}

const DEFAULT_LIMIT: EffectiveLimit = Object.freeze({ limit: FREE_LIMIT, source: 'default' });

/** Not in the future beyond FUTURE_TOLERANCE_MS and not older than maxAgeMs. */
export function isSaneTimestamp(atMs: number, nowMs: number, maxAgeMs: number = LIMIT_CACHE_MAX_AGE_MS): boolean {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return false;
  if (atMs > nowMs + FUTURE_TOLERANCE_MS) return false;
  return nowMs - atMs <= maxAgeMs;
}

/** -1 or an integer >= 1; anything else is not a usable limit. */
export function isValidLimit(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  return v === UNLIMITED || v >= FREE_LIMIT;
}

function cachedLimit(value: unknown, atMs: number, nowMs: number): number | null {
  return isValidLimit(value) && isSaneTimestamp(atMs, nowMs) ? value : null;
}

/** 6.8: local.json lastLimit needs a write: missing, another value, dated in the future, or due a refresh. */
export function lastLimitDue(last: { readonly value: number; readonly atMs: number } | null, limit: number, nowMs: number): boolean {
  if (last === null || last.value !== limit) return true;
  const ageMs = nowMs - last.atMs;
  return !(ageMs >= 0 && ageMs < LAST_LIMIT_REFRESH_MS);
}

export function effectiveLimit(input: LimitInputs): EffectiveLimit {
  if (!input.signedIn) return DEFAULT_LIMIT;
  if (input.confirmed && isValidLimit(input.serverLimit)) return { limit: input.serverLimit, source: 'server' };
  const local = input.localLast;
  const fromLocal = local === null ? null : cachedLimit(local.value, local.atMs, input.nowMs);
  if (fromLocal !== null) return { limit: fromLocal, source: 'local-json' };
  const tier = input.tierCache;
  const fromTier = tier === null ? null : cachedLimit(tier.vaultMaxOpenDevices, tier.timestampMs, input.nowMs);
  if (fromTier !== null) return { limit: fromTier, source: 'tier-cache' };
  return DEFAULT_LIMIT;
}

/** 6.7: owner claims are written and honored only when the effective limit is 1. */
export function claimsApply(limit: number): boolean {
  return limit === FREE_LIMIT;
}

export type ConduitEnvironment = 'preview' | 'production';

/**
 * 6.8: a packaged build always talks to production, whatever CONDUIT_ENV says, so a user-run
 * local Supabase answering `limit: -1` cannot lift the Free limit. Dev builds honor
 * CONDUIT_ENV and default to preview. For env-config.getEnvConfig (integration).
 */
export function resolveEnvironment(isPackaged: boolean, conduitEnv: string | undefined): ConduitEnvironment {
  if (isPackaged) return 'production';
  return conduitEnv === 'production' ? 'production' : 'preview';
}
