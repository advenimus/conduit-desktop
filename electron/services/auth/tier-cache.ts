/**
 * The cached tier copy in settings.json (`cached_tier_capabilities` + `cached_tier_timestamp`),
 * used offline and in cached mode. Spec 6.8: a copy older than 7 days is ignored, and so is one
 * dated more than 5 minutes in the future (a clock set back, or a hand-edited file, would
 * otherwise keep it valid forever). Pure; shares the rule with the device-limit cache.
 */

import { isSaneTimestamp, LIMIT_CACHE_MAX_AGE_MS } from '../vault-session/effective-limit.js';

export type TierCapabilities = Readonly<Record<string, unknown>>;

export interface CachedTierFields {
  readonly cached_tier_capabilities?: unknown;
  readonly cached_tier_timestamp?: unknown;
}

export type CachedTierVerdict =
  | { readonly ok: true; readonly capabilities: TierCapabilities }
  | { readonly ok: false; readonly reason: 'missing' | 'stale' | 'future' };

function isRecord(v: unknown): v is TierCapabilities {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function timestampMs(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Checks the cached copy against the clock; `reason` says why it cannot be used. */
export function checkCachedTier(fields: CachedTierFields, nowMs: number): CachedTierVerdict {
  const caps = fields.cached_tier_capabilities;
  const atMs = timestampMs(fields.cached_tier_timestamp);
  if (!isRecord(caps) || atMs === null) return { ok: false, reason: 'missing' };
  if (isSaneTimestamp(atMs, nowMs, LIMIT_CACHE_MAX_AGE_MS)) return { ok: true, capabilities: caps };
  return { ok: false, reason: atMs > nowMs ? 'future' : 'stale' };
}

/** The usable cached capabilities, or null. */
export function usableCachedTier(fields: CachedTierFields, nowMs: number): TierCapabilities | null {
  const verdict = checkCachedTier(fields, nowMs);
  return verdict.ok ? verdict.capabilities : null;
}
