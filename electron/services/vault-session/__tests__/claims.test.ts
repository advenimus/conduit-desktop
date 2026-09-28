// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyLocalWrites, prepareWrite, presenceWrite } from '../../sync/capture-local.js';
import { ownerRegKey } from '../../sync/catalog.js';
import { merge } from '../../sync/merge.js';
import { emptyState } from '../../sync/state-view.js';
import type { SessionRowView } from '../../sync/host.js';
import type { LocalWrite, PresenceValue, SyncState } from '../../sync/types.js';
import { DEVICE_A, GENESIS, LINEAGE, dot, implicitFor, makeCtx, type TestCtx } from '../../sync/__tests__/capture-fixtures.js';
import {
  claimWrites,
  evaluateClaims,
  readOwnerClaim,
  shouldDisplace,
  unlockClaimAction,
  type ClaimInputs,
  type ClaimVerdict,
} from '../claims.js';
import { effectiveLimit } from '../effective-limit.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60 * 1000;
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const DEV_A = 101;
const DEV_B = 202;
const HINT = 'a1'.repeat(16);

function ctxFor(deviceUuid: string, dev: number): TestCtx {
  return { ...makeCtx({ dev, nowMs: NOW }), deviceUuid };
}

const ctxA = ctxFor(DEVICE_A, DEV_A);
const ctxB = ctxFor(DEVICE_B, DEV_B);
const implicit = implicitFor(ctxA);

function apply(state: SyncState, writes: readonly LocalWrite[], ctx: TestCtx, ms: number): SyncState {
  return applyLocalWrites(state, writes, { kind: 'local', dot: dot(ctx.dev, ms), interactive: true }, ctx, implicit, { ruleR: false }).state;
}

function presence(patch: Partial<PresenceValue>): PresenceValue {
  return {
    platform: 'macos',
    name: 'MacBook',
    app_version: '0.18.0',
    first_seen_ms: NOW - 60 * MIN,
    last_active_ms: NOW - 5 * MIN,
    session_open: 1,
    session_since_ms: NOW - 30 * MIN,
    account_hint: null,
    file_hint: null,
    side_files_seen_ms: null,
    ...patch,
  };
}

function session(deviceId: string, status: SessionRowView['status']): SessionRowView {
  return {
    deviceId,
    deviceName: 'MacBook',
    platform: 'macos',
    fileName: 'Vault.conduit',
    fileId: null,
    location: null,
    status,
    lastActiveMs: NOW,
    busySessions: 0,
    busyJobs: 0,
    heartbeatAtMs: null,
    sideFilesFlag: false,
    marker: null,
    writtenAtMs: null,
    pendingChanges: false,
    abandoned: false,
  };
}

const base = emptyState(LINEAGE, GENESIS, 0);
/** B claimed the vault and wrote its presence at NOW - 5 min. */
const claimedByB = (p: Partial<PresenceValue> = {}): SyncState =>
  apply(base, [...claimWrites(null, ctxB), presenceWrite(presence(p), ctxB)], ctxB, NOW - 5 * MIN);

function verdictOn(state: SyncState, patch: Partial<ClaimInputs> = {}): ClaimVerdict {
  return evaluateClaims({
    state,
    ownDeviceUuid: DEVICE_A,
    effectiveLimit: 1,
    shared: true,
    leaseConfirmed: false,
    sessions: [],
    nowMs: NOW,
    ...patch,
  });
}

describe('readOwnerClaim and claimWrites', () => {
  it('writes one owner register with the JCS claim and reads it back with its dot', () => {
    const writes = claimWrites(HINT, ctxA);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toEqual(ownerRegKey());
    expect(writes[0].value).toBe(`{"a":"${HINT}","d":"${DEVICE_A}"}`);
    expect(Object.isFrozen(writes)).toBe(true);
    const state = apply(base, writes, ctxA, NOW);
    expect(readOwnerClaim(state)).toEqual({ value: { a: HINT, d: DEVICE_A }, ms: NOW, dev: DEV_A });
  });

  it('returns null when absent or unparseable', () => {
    expect(readOwnerClaim(base)).toBeNull();
    for (const bad of ['{"a":null,"d":"not-a-uuid"}', `{"a":7,"d":"${DEVICE_A}"}`, `{"d":"${DEVICE_A}"}`, '[1]', '"x"']) {
      const state = apply(base, [prepareWrite(ownerRegKey(), { value: bad }, ctxA, 'replace-all')], ctxA, NOW);
      expect(readOwnerClaim(state)).toBeNull();
    }
  });

  it('the highest-ranked claim is provisional after concurrent claims merge (12 row 28)', () => {
    const a = apply(base, claimWrites(null, ctxA), ctxA, NOW - 2 * MIN);
    const b = apply(base, claimWrites(null, ctxB), ctxB, NOW - MIN);
    const merged = merge(a, b, implicit).state;
    expect(readOwnerClaim(merged)?.value.d).toBe(DEVICE_B);
    expect(shouldDisplace(verdictOn(merged))).toBe(true);
    expect(verdictOn(merged, { ownDeviceUuid: DEVICE_B })).toEqual({ kind: 'ours' });
  });
});

describe('evaluateClaims', () => {
  it('does not apply to private vaults or limits other than 1', () => {
    const state = claimedByB();
    expect(verdictOn(state, { shared: false })).toEqual({ kind: 'not-applicable' });
    expect(verdictOn(state, { effectiveLimit: -1 })).toEqual({ kind: 'not-applicable' });
    expect(verdictOn(state, { effectiveLimit: 2 })).toEqual({ kind: 'not-applicable' });
    expect(unlockClaimAction(verdictOn(state, { effectiveLimit: -1 }))).toBe('skip');
    expect(shouldDisplace(verdictOn(state, { shared: false }))).toBe(false);
  });

  it('no claim yet: claim silently', () => {
    const v = verdictOn(base);
    expect(v).toEqual({ kind: 'none' });
    expect(unlockClaimAction(v)).toBe('claim');
    expect(shouldDisplace(v)).toBe(false);
  });

  it('our own claim, whatever the uuid case', () => {
    const state = apply(base, claimWrites(null, ctxA), ctxA, NOW);
    expect(verdictOn(state, { ownDeviceUuid: DEVICE_A.toUpperCase() })).toEqual({ kind: 'ours' });
    expect(shouldDisplace(verdictOn(state))).toBe(false);
  });

  it('another device active within 15 minutes: prompt at unlock, displace on merge', () => {
    const v = verdictOn(claimedByB());
    expect(v).toMatchObject({ kind: 'other', claimantUuid: DEVICE_B, recentlyActive: true });
    expect(v.kind === 'other' && v.presence?.name).toBe('MacBook');
    expect(unlockClaimAction(v)).toBe('prompt');
    expect(shouldDisplace(v)).toBe(true);
  });

  it('a stale or closed claimant is claimed over silently but still displaces on merge', () => {
    for (const p of [{ last_active_ms: NOW - 16 * MIN }, { session_open: 0 as const }]) {
      const v = verdictOn(claimedByB(p));
      expect(v).toMatchObject({ kind: 'other', recentlyActive: false });
      expect(unlockClaimAction(v)).toBe('claim');
      expect(shouldDisplace(v)).toBe(true);
    }
  });

  it('ignores activity dated more than 5 minutes in the future (12 row 70)', () => {
    expect(verdictOn(claimedByB({ last_active_ms: NOW + 30 * 24 * 60 * MIN }))).toMatchObject({ recentlyActive: false });
    expect(verdictOn(claimedByB({ last_active_ms: NOW + 4 * MIN }))).toMatchObject({ recentlyActive: true });
  });

  it('a claimant without presence is not recently active', () => {
    const state = apply(base, claimWrites(null, ctxB), ctxB, NOW);
    expect(verdictOn(state)).toEqual({ kind: 'other', claimantUuid: DEVICE_B, presence: null, recentlyActive: false });
  });

  it('both devices hold live leases: the server decides', () => {
    const v = verdictOn(claimedByB(), { leaseConfirmed: true, sessions: [session(DEVICE_B.toUpperCase(), 'active')] });
    expect(v).toEqual({ kind: 'ignored-leased', claimantUuid: DEVICE_B });
    expect(shouldDisplace(v)).toBe(false);
    expect(unlockClaimAction(v)).toBe('claim');
  });

  it('the exception needs a live claimant lease AND a confirmed own lease', () => {
    for (const status of ['released', 'expired', 'displaced'] as const) {
      expect(verdictOn(claimedByB(), { leaseConfirmed: true, sessions: [session(DEVICE_B, status)] }).kind).toBe('other');
    }
    expect(verdictOn(claimedByB(), { leaseConfirmed: false, sessions: [session(DEVICE_B, 'active')] }).kind).toBe('other');
  });

  it('same account on two devices with the host blocked still displaces (12 row 62)', () => {
    const limit = effectiveLimit({ signedIn: true, confirmed: false, serverLimit: null, localLast: null, tierCache: null, nowMs: NOW });
    const v = verdictOn(claimedByB({ account_hint: HINT }), { effectiveLimit: limit.limit, sessions: [session(DEVICE_B, 'active')] });
    expect(shouldDisplace(v)).toBe(true);
  });

  it('a signed-in desktop honors a signed-out iPad claim with a = null (12 row 29)', () => {
    const iPad = ctxFor('33333333-3333-4333-8333-333333333333', 303);
    const state = apply(base, [...claimWrites(null, iPad), presenceWrite(presence({ name: 'iPad' }), iPad)], iPad, NOW - MIN);
    const confirmedFree = effectiveLimit({ signedIn: true, confirmed: true, serverLimit: 1, localLast: null, tierCache: null, nowMs: NOW });
    const v = verdictOn(state, { effectiveLimit: confirmedFree.limit, leaseConfirmed: true, sessions: [session(DEVICE_B, 'active')] });
    expect(readOwnerClaim(state)?.value.a).toBeNull();
    expect(v).toMatchObject({ kind: 'other', recentlyActive: true });
    expect(shouldDisplace(v)).toBe(true);
  });

  it('signed out devices always evaluate with limit 1 (12 row 28)', () => {
    const signedOut = effectiveLimit({ signedIn: false, confirmed: false, serverLimit: null, localLast: null, tierCache: null, nowMs: NOW });
    expect(verdictOn(claimedByB(), { effectiveLimit: signedOut.limit }).kind).toBe('other');
  });
});
