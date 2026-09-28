// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FREE_LIMIT,
  FUTURE_TOLERANCE_MS,
  LAST_LIMIT_REFRESH_MS,
  LIMIT_CACHE_MAX_AGE_MS,
  UNLIMITED,
  claimsApply,
  effectiveLimit,
  isSaneTimestamp,
  isValidLimit,
  lastLimitDue,
  resolveEnvironment,
  type LimitInputs,
} from '../effective-limit.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

function inputs(patch: Partial<LimitInputs>): LimitInputs {
  return { signedIn: true, confirmed: false, serverLimit: null, localLast: null, tierCache: null, nowMs: NOW, ...patch };
}

describe('isValidLimit', () => {
  it.each([
    [UNLIMITED, true],
    [1, true],
    [5, true],
    [0, false],
    [-2, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ['1', false],
    [null, false],
    [undefined, false],
  ])('%s -> %s', (v, ok) => {
    expect(isValidLimit(v)).toBe(ok);
  });
});

describe('isSaneTimestamp', () => {
  it('accepts up to exactly 7 days old and up to 5 minutes in the future', () => {
    expect(isSaneTimestamp(NOW, NOW)).toBe(true);
    expect(isSaneTimestamp(NOW - LIMIT_CACHE_MAX_AGE_MS, NOW)).toBe(true);
    expect(isSaneTimestamp(NOW - LIMIT_CACHE_MAX_AGE_MS - 1, NOW)).toBe(false);
    expect(isSaneTimestamp(NOW + FUTURE_TOLERANCE_MS, NOW)).toBe(true);
    expect(isSaneTimestamp(NOW + FUTURE_TOLERANCE_MS + 1, NOW)).toBe(false);
  });

  it('rejects non-finite times and honors a custom max age', () => {
    expect(isSaneTimestamp(Number.NaN, NOW)).toBe(false);
    expect(isSaneTimestamp(NOW, Number.NaN)).toBe(false);
    expect(isSaneTimestamp(NOW - 2 * MIN, NOW, MIN)).toBe(false);
    expect(isSaneTimestamp(NOW - MIN, NOW, MIN)).toBe(true);
  });
});

describe('effectiveLimit: the 6.8 table', () => {
  it.each<[string, Partial<LimitInputs>, number, string]>([
    ['signed out ignores everything else', { signedIn: false, confirmed: true, serverLimit: UNLIMITED }, 1, 'default'],
    ['signed out ignores a sane Pro cache', { signedIn: false, tierCache: { vaultMaxOpenDevices: -1, timestampMs: NOW } }, 1, 'default'],
    ['confirmed Free', { confirmed: true, serverLimit: 1 }, 1, 'server'],
    ['confirmed Pro', { confirmed: true, serverLimit: UNLIMITED }, -1, 'server'],
    [
      'confirmed server wins over caches',
      { confirmed: true, serverLimit: 1, localLast: { value: -1, atMs: NOW }, tierCache: { vaultMaxOpenDevices: -1, timestampMs: NOW } },
      1,
      'server',
    ],
    ['confirmed with no server limit falls back to local.json', { confirmed: true, serverLimit: null, localLast: { value: -1, atMs: NOW - DAY } }, -1, 'local-json'],
    ['confirmed with an invalid server limit falls back', { confirmed: true, serverLimit: 0 }, 1, 'default'],
    ['unconfirmed ignores the server limit', { serverLimit: UNLIMITED }, 1, 'default'],
    ['unconfirmed: last server limit from local.json', { localLast: { value: -1, atMs: NOW - DAY } }, -1, 'local-json'],
    ['local.json exactly 7 days old still counts', { localLast: { value: -1, atMs: NOW - 7 * DAY } }, -1, 'local-json'],
    [
      'local.json older than 7 days falls through to the tier cache',
      { localLast: { value: -1, atMs: NOW - 7 * DAY - 1 }, tierCache: { vaultMaxOpenDevices: 1, timestampMs: NOW - DAY } },
      1,
      'tier-cache',
    ],
    [
      'future-dated local.json is rejected',
      { localLast: { value: -1, atMs: NOW + 30 * DAY }, tierCache: { vaultMaxOpenDevices: 1, timestampMs: NOW } },
      1,
      'tier-cache',
    ],
    ['local.json 5 minutes ahead is tolerated', { localLast: { value: -1, atMs: NOW + 5 * MIN } }, -1, 'local-json'],
    ['a sane Pro tier cache raises the offline limit (documented deviation)', { tierCache: { vaultMaxOpenDevices: -1, timestampMs: NOW - 6 * DAY } }, -1, 'tier-cache'],
    ['an 8-day-old Pro tier cache is ignored', { tierCache: { vaultMaxOpenDevices: -1, timestampMs: NOW - 8 * DAY } }, 1, 'default'],
    ['a future-dated Pro tier cache is ignored', { tierCache: { vaultMaxOpenDevices: -1, timestampMs: NOW + 10 * MIN } }, 1, 'default'],
    ['a tier cache without the key is ignored', { tierCache: { vaultMaxOpenDevices: null, timestampMs: NOW } }, 1, 'default'],
    ['an invalid cached value is ignored', { localLast: { value: 0, atMs: NOW }, tierCache: { vaultMaxOpenDevices: 1.5, timestampMs: NOW } }, 1, 'default'],
    ['a Team limit of 3 is kept as is', { localLast: { value: 3, atMs: NOW } }, 3, 'local-json'],
    ['nothing known: 1', {}, 1, 'default'],
  ])('%s', (_name, patch, limit, source) => {
    expect(effectiveLimit(inputs(patch))).toEqual({ limit, source });
  });

  it('server errors keep the vault usable at the cached limit (12 row 35)', () => {
    const offlineFree = effectiveLimit(inputs({ confirmed: false, localLast: { value: 1, atMs: NOW - 3 * DAY } }));
    expect(offlineFree).toEqual({ limit: FREE_LIMIT, source: 'local-json' });
    expect(claimsApply(offlineFree.limit)).toBe(true);
  });

  it('a Free user blocking the host gets limit 1 with claims (12 row 62)', () => {
    const blocked = effectiveLimit(inputs({ confirmed: false, serverLimit: null }));
    expect(blocked.limit).toBe(1);
    expect(claimsApply(blocked.limit)).toBe(true);
  });
});

describe('lastLimitDue: local.json lastLimit stays fresh while the server keeps confirming (6.8)', () => {
  it('writes a missing or changed value at once', () => {
    expect(lastLimitDue(null, UNLIMITED, NOW)).toBe(true);
    expect(lastLimitDue({ value: UNLIMITED, atMs: NOW - MIN }, FREE_LIMIT, NOW)).toBe(true);
  });

  it('re-dates the same value once it is a refresh interval old, not on every heartbeat', () => {
    expect(lastLimitDue({ value: UNLIMITED, atMs: NOW - MIN }, UNLIMITED, NOW)).toBe(false);
    expect(lastLimitDue({ value: UNLIMITED, atMs: NOW - LAST_LIMIT_REFRESH_MS + 1 }, UNLIMITED, NOW)).toBe(false);
    expect(lastLimitDue({ value: UNLIMITED, atMs: NOW - LAST_LIMIT_REFRESH_MS }, UNLIMITED, NOW)).toBe(true);
  });

  it('rewrites a value dated in the future or with a broken time', () => {
    expect(lastLimitDue({ value: UNLIMITED, atMs: NOW + MIN }, UNLIMITED, NOW)).toBe(true);
    expect(lastLimitDue({ value: UNLIMITED, atMs: Number.NaN }, UNLIMITED, NOW)).toBe(true);
  });
});

describe('claimsApply', () => {
  it('only a limit of exactly 1 uses claims', () => {
    expect(claimsApply(1)).toBe(true);
    expect(claimsApply(UNLIMITED)).toBe(false);
    expect(claimsApply(2)).toBe(false);
  });
});

describe('resolveEnvironment: packaged builds ignore CONDUIT_ENV (6.8)', () => {
  it.each<[boolean, string | undefined, 'preview' | 'production']>([
    [true, 'preview', 'production'],
    [true, undefined, 'production'],
    [true, 'production', 'production'],
    [false, 'production', 'production'],
    [false, 'preview', 'preview'],
    [false, undefined, 'preview'],
    [false, 'staging', 'preview'],
  ])('packaged=%s CONDUIT_ENV=%s -> %s', (packaged, env, expected) => {
    expect(resolveEnvironment(packaged, env)).toBe(expected);
  });
});
