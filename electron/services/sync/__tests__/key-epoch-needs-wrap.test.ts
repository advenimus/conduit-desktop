// @vitest-environment node
// Review finding 10 (spec 4.8): after a legacy password change was absorbed by a device that
// lacked the old key, S's new epoch has no wrap to W's epoch. A device that holds W's key must
// accept the new password ('needs-wrap'), add the wrap and re-encrypt, instead of reporting a
// wrong password forever.
import { afterEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { buildKeyRing, createWrap, decideUnlock, linkMissingWrap, requireCurrentEpoch } from '../key-epoch.js';
import { SyncCoreError } from '../types.js';
import { NEW_PASSWORD, OLD_PASSWORD } from './core-e2e-fixtures.js';
import { epochKeysFor, fakeDerive, makeState, recordFor, seqRandom, LINEAGE } from './key-epoch-fixtures.js';
import { advance, converge, setupWorld, teardownWorld, type World } from './sim-world.js';

let w: World | null = null;
afterEach(() => {
  teardownWorld(w);
  w = null;
});

const rand = seqRandom(23);
const E1 = epochKeysFor('pw1', 'salt1');
const E2 = epochKeysFor('pw2', 'salt2');
const R1 = recordFor(E1, null, 'salt1', rand);
const R2 = recordFor(E2, E1, 'salt2', rand);

function decide(password: string) {
  const wState = makeState({ current: E1, records: [R1], wraps: [], epochMs: 1_000, deviceUuid: 'mac' });
  const sState = makeState({ current: E2, records: [R1, R2], wraps: [], epochMs: 2_000, deviceUuid: 'pc' });
  const meta = { salt: 'salt2', verification: R2.verification };
  return { wState, sState, out: decideUnlock({ lineageId: LINEAGE, deriveFromSalt: fakeDerive(password), w: wState, s: { state: sState, meta } }) };
}

describe('unlock without a wrap to W (finding 10)', () => {
  it("accepts the new password as 'needs-wrap', and the old one still only for W", () => {
    expect(decide('pw2').out.decision).toEqual({ ok: true, epochId: E2.epochId, via: 'needs-wrap' });
    expect(decide('pw2').out.key?.equals(E2.kEpoch)).toBe(true);
    expect(decide('pw1').out.decision).toMatchObject({ ok: true, via: 'w-current', epochId: E1.epochId });
    expect(decide('nope').out.decision).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('linkMissingWrap lets the new key reach W epoch through a valid wrap', () => {
    const { wState, sState } = decide('pw2');
    const linked = linkMissingWrap(wState, sState, E2, E1, rand);
    const ring = buildKeyRing({ ...linked, epochs: sState.epochs }, E2, LINEAGE);
    expect(ring.byEpoch.has(E1.epochId)).toBe(true);
    const unrelated = makeState({ current: E2, records: [R1, recordFor(E2, null, 'salt2', rand)], wraps: [], epochMs: 2_000 });
    expect(() => linkMissingWrap(wState, unrelated, E2, E1, rand)).toThrow(SyncCoreError);
    expect(createWrap(E2, E1, rand).targetEpoch).toBe(E1.epochId);
  });

  it('a device holding the old key adopts a keyless legacy absorb and keeps syncing', () => {
    w = setupWorld();
    const { a, b } = w;
    const { web } = w.fixture.ids;
    converge(w);
    advance(w);
    a.publish(w.shared);
    advance(w);
    const older = new ConduitVault(w.shared);
    older.unlock(OLD_PASSWORD);
    older.changePassword(OLD_PASSWORD, NEW_PASSWORD);
    older.lock();
    advance(w);
    b.adoptLegacyPasswordChange(w.shared, NEW_PASSWORD, false);
    b.publish(w.shared);
    advance(w);
    expect(a.sync(w.shared)).toMatchObject({ kind: 'paused', align: { kind: 'pause-newer' } });
    const decision = a.enterNewPassword(w.shared, NEW_PASSWORD);
    expect(decision).toMatchObject({ ok: true, via: 'needs-wrap' });
    expect(requireCurrentEpoch(a.state, 'working')).toBe(requireCurrentEpoch(b.state, 'working'));
    expect(a.opensWithPassword(NEW_PASSWORD)).toBe(true);
    expect(a.vault.getEntry(web)?.password).toBe('pw-web');
    a.publish(w.shared);
    advance(w);
    expect(b.sync(w.shared).kind).toBe('merged');
    expect(b.vault.getEntry(web)?.password).toBe('pw-web');
  });
});
