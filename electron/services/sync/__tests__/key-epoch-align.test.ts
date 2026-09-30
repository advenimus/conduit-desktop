// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { epochRegKey } from '../catalog.js';
import { vhashOfSecret } from '../hashing.js';
import {
  alignEpoch,
  buildKeyRing,
  createWrap,
  epochRelation,
  makeVerificationToken,
  readSecret,
  type FileKeyMeta,
} from '../key-epoch.js';
import { StateBuilder, getRegister } from '../state-view.js';
import { SyncCoreError, type EpochKeys, type SyncState, type WrapRecord } from '../types.js';
import { LINEAGE, epochKeysFor, makeState, passwordKey, recordFor, ringOf, secretSib, seqRandom, withRegister } from './key-epoch-fixtures.js';

const rand = seqRandom(7);
const E1 = epochKeysFor('pw1', 'salt1');
const E2 = epochKeysFor('pw2', 'salt2');
const E2b = epochKeysFor('pw2b', 'salt2b');
const R1 = recordFor(E1, null, 'salt1', rand);
const R2 = recordFor(E2, E1, 'salt2', rand);
const R2b = recordFor(E2b, E1, 'salt2b', rand);
const PW = passwordKey('e1');

function metaOf(state: SyncState, epoch: EpochKeys): FileKeyMeta {
  const rec = state.epochs.get(epoch.epochId);
  return { salt: rec?.salt ?? null, verification: rec?.verification ?? null };
}

function at(current: EpochKeys, records = [R1, R2, R2b], wraps: WrapRecord[] = [], dev = 7, ms = 1_000, uuid = 'device-a'): SyncState {
  return makeState({ current, records, wraps, epochDev: dev, epochMs: ms, deviceUuid: uuid });
}

describe('epochRelation (4.8 table)', () => {
  it('classifies same, older, newer, legacy and concurrent', () => {
    const w1 = at(E1);
    const w2 = at(E2);
    expect(epochRelation(at(E1), metaOf(w1, E1), w1)).toBe('same');
    expect(epochRelation(at(E1), metaOf(w1, E1), w2)).toBe('s-older');
    expect(epochRelation(at(E2), metaOf(w2, E2), w1)).toBe('s-newer');
    expect(epochRelation(at(E2b), metaOf(w2, E2b), w2)).toBe('concurrent');
    const legacyMeta = { salt: 'salt-legacy', verification: makeVerificationToken(E2, rand) };
    expect(epochRelation(at(E1), legacyMeta, w1)).toBe('legacy-change');
  });

  it('checks S-older on W epochs and S-newer on S epochs', () => {
    const wOnly2 = at(E2, [R1, R2]);
    const sOnly1 = at(E1, [R1]);
    expect(epochRelation(sOnly1, metaOf(sOnly1, E1), wOnly2)).toBe('s-older');
    expect(epochRelation(wOnly2, metaOf(wOnly2, E2), sOnly1)).toBe('s-newer');
  });

  it('orders a resolved concurrent change through the loser wrap', () => {
    const winner = at(E2, [R1, R2, R2b], [createWrap(E2, E2b, rand)]);
    const loser = at(E2b);
    expect(epochRelation(loser, metaOf(loser, E2b), winner)).toBe('s-older');
    expect(epochRelation(winner, metaOf(winner, E2), loser)).toBe('s-newer');
  });

  it('treats a state without an epoch register as corrupt', () => {
    const b = new StateBuilder(at(E1));
    b.removeRegister(epochRegKey());
    expect(() => epochRelation(b.build(), { salt: null, verification: null }, at(E1))).toThrow(SyncCoreError);
  });
});

describe('alignEpoch', () => {
  it('same: proceeds with S1 itself', () => {
    const s = at(E1);
    const res = alignEpoch(s, metaOf(s, E1), at(E1), ringOf(E1));
    expect(res).toEqual({ kind: 'proceed', state: s, relation: 'same' });
    if (res.kind === 'proceed') expect(res.state).toBe(s);
  });

  it('S older: re-encrypts S1 up to W epoch in memory, no new dots', () => {
    const w = at(E2, [R1, R2], [createWrap(E2, E1, rand)]);
    const s = withRegister(at(E1, [R1]), PW, [secretSib(PW, 'old-pw', E1, rand, 4, 400)]);
    const res = alignEpoch(s, metaOf(s, E1), w, buildKeyRing(w, E2, LINEAGE));
    expect(res.kind).toBe('proceed');
    if (res.kind !== 'proceed') return;
    expect(res.relation).toBe('s-older');
    const sib = getRegister(res.state, PW)?.sibs[0];
    expect(sib && readSecret(sib.value as Uint8Array, ringOf(E2))).toEqual({ kind: 'current', plaintext: 'old-pw' });
    expect(sib?.vhash).toBe(vhashOfSecret(PW, 'old-pw', E2.kSync));
    expect(res.state.vv).toBe(s.vv);
  });

  it('S older through a wrap only S1 carries: the ring is extended from S1', () => {
    const w = at(E2, [R1, R2]);
    const s = withRegister(at(E1, [R1, R2], [createWrap(E2, E1, rand)]), PW, [secretSib(PW, 'x', E1, rand)]);
    const res = alignEpoch(s, metaOf(s, E1), w, ringOf(E2));
    expect(res.kind === 'proceed' && res.relation).toBe('s-older');
    if (res.kind === 'proceed') expect(getRegister(res.state, PW)?.sibs[0].vhash).toBe(vhashOfSecret(PW, 'x', E2.kSync));
  });

  it('S newer: pauses with the device and time of the epoch change', () => {
    const s = at(E2, [R1, R2], [createWrap(E2, E1, rand)], 9, 5_000, 'macbook');
    const res = alignEpoch(s, metaOf(s, E2), at(E1), ringOf(E1));
    expect(res).toEqual({ kind: 'pause-newer', sEpochId: E2.epochId, changedByDeviceUuid: 'macbook', changedMs: 5_000 });
  });

  it('legacy change: vault_meta no longer matches the recorded epoch', () => {
    const s = at(E1);
    const meta = { salt: 'salt-legacy', verification: makeVerificationToken(E2, rand) };
    expect(alignEpoch(s, meta, at(E1), ringOf(E1))).toEqual({ kind: 'legacy-change' });
  });

  it('a verification token re-encrypted under the same key is not a password change', () => {
    const s = at(E1);
    const meta = { salt: 'salt1', verification: makeVerificationToken(E1, rand) };
    expect(epochRelation(s, meta, at(E1))).toBe('legacy-change');
    expect(alignEpoch(s, meta, at(E1), ringOf(E1)).kind).toBe('proceed');
  });

  it('concurrent: reports both epoch ids until the loser is wrapped under the winner', () => {
    const s = withRegister(at(E2b), PW, [secretSib(PW, 'b-side', E2b, rand)]);
    const res = alignEpoch(s, metaOf(s, E2b), at(E2), ringOf(E2));
    expect(res).toEqual({ kind: 'concurrent', epochIds: [E2.epochId, E2b.epochId] });

    const resolved = at(E2, [R1, R2, R2b], [createWrap(E2, E2b, rand)]);
    const after = alignEpoch(s, metaOf(s, E2b), resolved, buildKeyRing(resolved, E2, LINEAGE));
    expect(after.kind === 'proceed' && after.relation).toBe('s-older');
    if (after.kind === 'proceed') {
      const sib = getRegister(after.state, PW)?.sibs[0];
      expect(sib && readSecret(sib.value as Uint8Array, ringOf(E2))).toEqual({ kind: 'current', plaintext: 'b-side' });
    }
  });

  it('refuses a ring that does not belong to W', () => {
    const s = at(E1);
    expect(() => alignEpoch(s, metaOf(s, E1), at(E1), ringOf(E2))).toThrow(/key ring/);
  });
});
