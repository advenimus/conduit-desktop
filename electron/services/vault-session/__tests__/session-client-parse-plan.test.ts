// @vitest-environment node
// Plan enforcement answers (docs/PLAN_ENFORCEMENT.md 2.5.1, 2.10): every new shape of peek,
// acquire, heartbeat and vault_owner_release, and the parser rules shared with iOS.
import { describe, expect, it } from 'vitest';
import { parseAcquireData, parseHeartbeatData, parseOwnerReleaseData, parsePeekData } from '../session-client-parse.js';
import { LEASE, OTHER, TS, TS_MS, holderRow } from './session-client-fixtures.js';

const LATER = '2026-10-13T12:00:00.000Z';
const LATER_MS = Date.parse(LATER);
const THIRD = '55555555-5555-4555-8555-555555555599';

const grant = (extra: Record<string, unknown> = {}) => ({ granted: true, lease_id: LEASE, limit: -1, sessions: [], server_now: TS, ...extra });
const denial = (extra: Record<string, unknown> = {}) => ({ granted: false, limit: 1, holders: [holderRow()], sessions: [], server_now: TS, ...extra });

function value<T>(parsed: { ok: true; value: T } | { ok: false; detail: string }): T {
  if (!parsed.ok) throw new Error(`malformed: ${parsed.detail}`);
  return parsed.value;
}

describe('acquire grants', () => {
  it('reads device_cap and each ownership kind', () => {
    expect(value(parseAcquireData(grant({ device_cap: 5, ownership: 'owner', release_after: LATER, shared_until: null })))).toMatchObject({
      kind: 'granted',
      deviceCap: 5,
      ownership: { kind: 'owner', releaseAfterMs: LATER_MS, sharedUntilMs: null },
    });
    expect(value(parseAcquireData(grant({ ownership: 'owner', release_after: TS, shared_until: LATER })))).toMatchObject({
      ownership: { kind: 'owner', releaseAfterMs: TS_MS, sharedUntilMs: LATER_MS },
    });
    expect(value(parseAcquireData(grant({ ownership: 'grace', grace_until: LATER })))).toMatchObject({ ownership: { kind: 'grace', untilMs: LATER_MS } });
    expect(value(parseAcquireData(grant({ ownership: 'unowned', grace_until: null, release_after: null, shared_until: null })))).toMatchObject({
      ownership: { kind: 'unowned' },
    });
  });

  it('treats absent ownership and device_cap as unknown (older server)', () => {
    expect(value(parseAcquireData(grant()))).toMatchObject({ kind: 'granted', deviceCap: null, ownership: null });
    expect(value(parseAcquireData(grant({ device_cap: -1 })))).toMatchObject({ deviceCap: -1 });
  });

  it.each([
    ['an unknown ownership', { ownership: 'guest' }],
    ['grace without grace_until', { ownership: 'grace' }],
    ['a bad release_after', { ownership: 'owner', release_after: 'soon' }],
    ['a device_cap of 0', { device_cap: 0 }],
    ['a string device_cap', { device_cap: '5' }],
  ])('is malformed with %s', (_label, extra) => {
    expect(parseAcquireData(grant(extra)).ok).toBe(false);
  });
});

describe('acquire denials', () => {
  it('reads a reason-less denial as the per-vault limit (older server)', () => {
    expect(value(parseAcquireData(denial()))).toMatchObject({ kind: 'denied', cause: 'vault_limit', deviceCap: null, alsoLocks: null });
  });

  it('reads vault_limit with also_locks (S1b)', () => {
    const res = value(parseAcquireData(denial({ reason: 'vault_limit', device_cap: 5, also_locks: { device_id: THIRD.toUpperCase(), device_name: 'Old PC' } })));
    expect(res).toMatchObject({ kind: 'denied', cause: 'vault_limit', deviceCap: 5, alsoLocks: { deviceId: THIRD, deviceName: 'Old PC' } });
    expect(value(parseAcquireData(denial({ reason: 'vault_limit', also_locks: null })))).toMatchObject({ alsoLocks: null });
  });

  it('reads device_cap with device holders and their vault counts', () => {
    const res = value(parseAcquireData(denial({ reason: 'device_cap', limit: -1, device_cap: 5, holders: [holderRow({ vaults: 2 })] })));
    expect(res).toMatchObject({ kind: 'denied', cause: 'device_cap', deviceCap: 5, holders: [{ deviceId: OTHER, vaults: 2 }] });
  });

  it('reads not_owner with an empty holder list, released absent as false', () => {
    expect(value(parseAcquireData({ granted: false, reason: 'not_owner', limit: 1, grace_ended_at: TS, holders: [], sessions: [], server_now: TS }))).toEqual({
      kind: 'not-owner',
      graceEndedMs: TS_MS,
      released: false,
      serverNowMs: TS_MS,
    });
    expect(value(parseAcquireData({ granted: false, reason: 'not_owner', released: true, holders: [], sessions: [], server_now: TS }))).toMatchObject({
      kind: 'not-owner',
      graceEndedMs: null,
      released: true,
    });
  });

  it('reads update_required with its minimum version', () => {
    expect(value(parseAcquireData({ granted: false, reason: 'update_required', limit: 1, min_version: '0.19.0', holders: [], sessions: [], server_now: TS }))).toEqual({
      kind: 'update-required',
      minVersion: '0.19.0',
      serverNowMs: TS_MS,
    });
  });

  it.each([
    ['an unknown reason', denial({ reason: 'geo_blocked' })],
    ['vault_limit without holders', denial({ reason: 'vault_limit', holders: [] })],
    ['a reason-less denial without holders', denial({ holders: [] })],
    ['device_cap without holders', denial({ reason: 'device_cap', device_cap: 5, holders: [] })],
    ['device_cap without device_cap', denial({ reason: 'device_cap' })],
    ['update_required without min_version', { granted: false, reason: 'update_required', holders: [], sessions: [], server_now: TS }],
    ['update_required with an empty min_version', { granted: false, reason: 'update_required', min_version: '', server_now: TS }],
    ['update_required with a 41-character min_version', { granted: false, reason: 'update_required', min_version: '1'.repeat(41), server_now: TS }],
    ['not_owner with a string released', { granted: false, reason: 'not_owner', released: 'yes', server_now: TS }],
    ['also_locks without a device id', denial({ also_locks: { device_name: 'PC' } })],
  ])('is malformed with %s (unconfirmed: the vault still opens)', (_label, data) => {
    expect(parseAcquireData(data).ok).toBe(false);
  });
});

describe('heartbeat', () => {
  it('reads the new ok fields', () => {
    const res = value(parseHeartbeatData({ status: 'ok', limit: -1, sessions: [], server_now: TS, device_cap: 5, ownership: 'owner', release_after: null, shared_until: LATER }));
    expect(res).toMatchObject({ kind: 'ok', deviceCap: 5, ownership: { kind: 'owner', releaseAfterMs: null, sharedUntilMs: LATER_MS } });
    expect(value(parseHeartbeatData({ status: 'ok', limit: 1, sessions: [], server_now: TS, ownership: 'unowned' }))).toMatchObject({ ownership: { kind: 'unowned' } });
  });

  it.each([
    ['device_cap', { reason: 'device_cap', by: 'iPhone' }, { reason: 'device_cap', byDeviceName: 'iPhone', minVersion: null, released: false }],
    ['not_owner', { reason: 'not_owner', by: null, grace_ended_at: TS, released: true }, { reason: 'not_owner', byDeviceName: null, minVersion: null, released: true }],
    ['update_required', { reason: 'update_required', by: null, min_version: '0.19.0' }, { reason: 'update_required', byDeviceName: null, minVersion: '0.19.0', released: false }],
  ])('reads displaced %s', (_label, extra, want) => {
    expect(value(parseHeartbeatData({ status: 'displaced', ...extra }))).toEqual({ kind: 'displaced', ...want });
  });

  it.each([
    ['an unknown displaced reason', { status: 'displaced', reason: 'geo', by: null }],
    ['an unknown ownership', { status: 'ok', limit: 1, sessions: [], server_now: TS, ownership: 'maybe' }],
    ['a numeric min_version', { status: 'displaced', reason: 'update_required', min_version: 19 }],
  ])('is malformed with %s', (_label, data) => {
    expect(parseHeartbeatData(data).ok).toBe(false);
  });
});

describe('peek', () => {
  it('reads device_cap and no refusal', () => {
    expect(value(parsePeekData({ limit: 1, holders: [], device_cap: 5 }))).toEqual({ limit: 1, deviceCap: 5, holders: [], refusal: null });
  });

  it('reads the update_required and device_cap refusals', () => {
    expect(value(parsePeekData({ limit: 1, holders: [], reason: 'update_required', min_version: '0.19.0' })).refusal).toEqual({
      kind: 'update-required',
      minVersion: '0.19.0',
    });
    const cap = value(parsePeekData({ limit: -1, holders: [], device_cap: 5, reason: 'device_cap', devices: [holderRow({ vaults: 1 })] }));
    expect(cap.refusal).toMatchObject({ kind: 'device-cap', deviceCap: 5, devices: [{ deviceId: OTHER, vaults: 1 }] });
  });

  it.each([
    ['an unknown reason', { limit: 1, holders: [], reason: 'not_owner' }],
    ['device_cap without devices', { limit: 1, holders: [], device_cap: 5, reason: 'device_cap', devices: [] }],
    ['device_cap without its cap', { limit: 1, holders: [], reason: 'device_cap', devices: [holderRow()] }],
  ])('is malformed with %s', (_label, data) => {
    expect(parsePeekData(data).ok).toBe(false);
  });
});

describe('vault_owner_release', () => {
  it('reads the three answers', () => {
    expect(value(parseOwnerReleaseData({ released: true }))).toEqual({ released: true });
    expect(value(parseOwnerReleaseData({ released: false, reason: 'not_owner' }))).toEqual({ released: false, reason: 'not_owner' });
    expect(value(parseOwnerReleaseData({ released: false, reason: 'too_soon', retry_after: LATER }))).toEqual({
      released: false,
      reason: 'too_soon',
      retryAfterMs: LATER_MS,
    });
  });

  it.each([[null], [{}], [{ released: false }], [{ released: false, reason: 'too_soon' }], [{ released: false, reason: 'other' }]])('is malformed for %j', (data) => {
    expect(parseOwnerReleaseData(data).ok).toBe(false);
  });
});
