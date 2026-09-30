// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { vhashUndecryptable } from '../hashing.js';
import { createWrap, decideUnlock, makeVerificationToken, redactSuperseded, buildKeyRing, type UnlockInput } from '../key-epoch.js';
import { currentEpochId } from '../state-view.js';
import { SIB_UNDECRYPTABLE, type SyncState, type WrapRecord } from '../types.js';
import { LINEAGE, appSib, epochKeysFor, fakeDerive, makeState, passwordKey, recordFor, seqRandom, withRegister } from './key-epoch-fixtures.js';

const rand = seqRandom(11);
const E1 = epochKeysFor('pw1', 'salt1');
const E2 = epochKeysFor('pw2', 'salt2');
const EL = epochKeysFor('pw-legacy', 'salt-legacy');
const R1 = recordFor(E1, null, 'salt1', rand);
const R2 = recordFor(E2, E1, 'salt2', rand);
const W21 = createWrap(E2, E1, rand);
const LEGACY_META = { salt: 'salt-legacy', verification: makeVerificationToken(EL, rand) };

function at(current: typeof E1, records = [R1, R2], wraps: WrapRecord[] = [W21], ms = 1_000, uuid = 'macbook'): SyncState {
  return makeState({ current, records, wraps, epochMs: ms, deviceUuid: uuid });
}

function meta(state: SyncState) {
  const rec = state.epochs.get(currentEpochId(state) ?? '');
  return { salt: rec?.salt ?? null, verification: rec?.verification ?? null };
}

function unlock(password: string, w: SyncState | null, s: SyncState | null | 'presync', sMeta = s && s !== 'presync' ? meta(s) : LEGACY_META) {
  const input: UnlockInput = {
    lineageId: LINEAGE,
    deriveFromSalt: fakeDerive(password),
    w,
    s: s === null ? null : { state: s === 'presync' ? null : s, meta: sMeta },
  };
  return decideUnlock(input);
}

/** W at E2 with E1 redacted; `keepSalt` simulates undecryptable siblings that keep old salts. */
function redactedW2(keepSalt: boolean): SyncState {
  let w = at(E2, [R1, R2], [W21], 2_000, 'macbook');
  if (keepSalt) {
    const ct = Buffer.alloc(40, 3);
    w = withRegister(w, passwordKey('e9'), [appSib(1, 10, ct, vhashUndecryptable(ct), SIB_UNDECRYPTABLE)]);
  }
  return redactSuperseded(w, buildKeyRing(w, E2, LINEAGE));
}

describe('unlock policy (4.8)', () => {
  it("accepts the key of W's current epoch", () => {
    const out = unlock('pw1', at(E1, [R1], []), null);
    expect(out.decision).toEqual({ ok: true, epochId: E1.epochId, via: 'w-current' });
    expect(out.key?.equals(E1.kEpoch)).toBe(true);
  });

  it('rejects an ancestor password as superseded while its salt is retained', () => {
    const out = unlock('pw1', redactedW2(true), null);
    expect(out.decision).toEqual({ ok: false, reason: 'superseded', changedByDeviceUuid: 'macbook', changedMs: 2_000 });
    expect(out.key).toBeNull();
  });

  it('cannot even test an ancestor password once its salt is redacted', () => {
    const w = redactedW2(false);
    expect(w.epochs.get(E1.epochId)).toMatchObject({ salt: null, verification: null });
    expect(unlock('pw1', w, null).decision).toEqual({ ok: false, reason: 'wrong-password' });
    expect(unlock('pw2', w, null).decision).toMatchObject({ ok: true, via: 'w-current' });
  });

  it("accepts S's newer epoch only when it reaches W's through valid wraps", () => {
    const w = at(E1, [R1], []);
    const good = unlock('pw2', w, at(E2, [R1, R2], [W21], 5_000));
    expect(good.decision).toEqual({ ok: true, epochId: E2.epochId, via: 's-newer' });
    expect(good.key?.equals(E2.kEpoch)).toBe(true);

    const bytes = Buffer.from(W21.wrap, 'hex');
    bytes[20] ^= 0xff;
    const forgedWrap = { ...W21, wrap: bytes.toString('hex') };
    // A forged wrap never links the epochs: E2 descends from E1, so W's key must add a real one.
    const forged = at(E2, [R1, R2], [forgedWrap]);
    expect(unlock('pw2', w, forged).decision).toEqual({ ok: true, epochId: E2.epochId, via: 'needs-wrap' });
    const unrelated = at(E2, [R1, recordFor(E2, null, 'salt2', rand)], [forgedWrap]);
    expect(unlock('pw2', w, unrelated).decision).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('keeps accepting the old password on a device whose W has not moved yet', () => {
    const out = unlock('pw1', at(E1, [R1], []), at(E2));
    expect(out.decision).toMatchObject({ ok: true, via: 'w-current', epochId: E1.epochId });
  });

  it("with no W, accepts S's current epoch and rejects its retained ancestors", () => {
    expect(unlock('pw2', null, at(E2)).decision).toEqual({ ok: true, epochId: E2.epochId, via: 'no-w' });
    expect(unlock('pw1', null, at(E2, [R1, R2], [W21], 3_000, 'ipad')).decision).toEqual({
      ok: false,
      reason: 'superseded',
      changedByDeviceUuid: 'ipad',
      changedMs: 3_000,
    });
  });

  it('with no W and a pre-sync S, accepts the key that opens its vault_meta', () => {
    const presyncMeta = { salt: 'salt1', verification: R1.verification };
    const out = unlock('pw1', null, 'presync', presyncMeta);
    expect(out.decision).toEqual({ ok: true, epochId: E1.epochId, via: 'no-w' });
    expect(unlock('nope', null, 'presync', presyncMeta).decision).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('after a legacy password change accepts the new password, and the recorded one only on an unmoved W', () => {
    const s = at(E1, [R1], []);
    expect(unlock('pw-legacy', at(E1, [R1], []), s, LEGACY_META).decision).toEqual({
      ok: true,
      epochId: EL.epochId,
      via: 'legacy-change',
    });
    expect(unlock('pw1', at(E1, [R1], []), s, LEGACY_META).decision).toMatchObject({ ok: true, via: 'w-current' });
    expect(unlock('pw1', null, s, LEGACY_META).decision).toEqual({
      ok: false,
      reason: 'superseded',
      changedByDeviceUuid: null,
      changedMs: 0,
    });
    expect(unlock('pw-legacy', null, s, LEGACY_META).decision).toMatchObject({ ok: true, via: 'legacy-change' });
  });

  it('never treats a pre-sync copy under a known ancestor epoch as a legacy change', () => {
    const w = at(E2, [R1, R2], [W21]);
    const oldCopyMeta = { salt: 'salt1', verification: R1.verification };
    expect(unlock('pw1', w, 'presync', oldCopyMeta).decision).toMatchObject({ ok: false, reason: 'superseded' });
    expect(unlock('pw-legacy', w, 'presync', LEGACY_META).decision).toMatchObject({ ok: true, via: 'legacy-change' });
  });

  it('recognizes the old password through an older S or old copy even after W redacted it', () => {
    const w = redactedW2(false);
    const olderS = at(E1, [R1], []);
    expect(unlock('pw1', w, olderS).decision).toEqual({
      ok: false,
      reason: 'superseded',
      changedByDeviceUuid: 'macbook',
      changedMs: 2_000,
    });
    const oldCopyMeta = { salt: 'salt1', verification: R1.verification };
    expect(unlock('pw1', w, 'presync', oldCopyMeta).decision).toMatchObject({ ok: false, reason: 'superseded' });
    expect(unlock('pw2', w, olderS).decision).toMatchObject({ ok: true, via: 'w-current' });
  });

  it('derives each salt at most once per decision', () => {
    const salts: string[] = [];
    const w = at(E1, [R1], []);
    decideUnlock({
      lineageId: LINEAGE,
      deriveFromSalt: (salt) => {
        salts.push(salt);
        return fakeDerive('wrong')(salt);
      },
      w,
      s: { state: at(E1, [R1], []), meta: { salt: 'salt1', verification: R1.verification } },
    });
    expect(salts).toEqual(['salt1']);
  });
});
