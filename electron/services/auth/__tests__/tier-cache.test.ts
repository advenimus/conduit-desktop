// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkCachedTier, usableCachedTier } from '../tier-cache.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const CAPS = { cloud_sync_enabled: true, vault_max_open_devices: -1 };

function at(ms: number) {
  return { cached_tier_capabilities: CAPS, cached_tier_timestamp: new Date(ms).toISOString() };
}

describe('cached tier sanity (spec 6.8)', () => {
  it('accepts a copy up to 7 days old', () => {
    expect(usableCachedTier(at(NOW - 7 * DAY), NOW)).toEqual(CAPS);
    expect(checkCachedTier(at(NOW - 7 * DAY - 1), NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a copy dated more than 5 minutes in the future', () => {
    expect(usableCachedTier(at(NOW + 5 * MIN), NOW)).toEqual(CAPS);
    expect(checkCachedTier(at(NOW + 5 * MIN + 1), NOW)).toEqual({ ok: false, reason: 'future' });
    expect(usableCachedTier(at(NOW + 365 * DAY), NOW)).toBeNull();
  });

  it('treats a missing or malformed copy as missing', () => {
    expect(checkCachedTier({}, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(checkCachedTier({ cached_tier_capabilities: CAPS, cached_tier_timestamp: 'not a date' }, NOW).ok).toBe(false);
    expect(checkCachedTier({ cached_tier_capabilities: [1], cached_tier_timestamp: new Date(NOW).toISOString() }, NOW).ok).toBe(false);
  });
});
