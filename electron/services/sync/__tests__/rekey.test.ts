// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LIFE_DEAD, LIFE_REG, epochRegKey, regKey } from '../catalog.js';
import { vhashOfSecret, vhashOfValue } from '../hashing.js';
import { buildKeyRing, createWrap, encryptSecret, readSecret, unwrapValidated, verifyKey } from '../key-epoch.js';
import { changePassword } from '../rekey.js';
import { currentEpochId, getRegister, wrapKeyStr } from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, SyncCoreError, TBL, type SyncState } from '../types.js';
import {
  LINEAGE,
  appSib,
  epochKeysFor,
  fakeDerive,
  makeState,
  passwordKey,
  recordFor,
  ringOf,
  secretSib,
  seqRandom,
  testContext,
  withRegister,
} from './key-epoch-fixtures.js';

const rand = seqRandom(21);
const E0 = epochKeysFor('pw0', 'salt0');
const E1 = epochKeysFor('pw1', 'salt1');
const E2 = epochKeysFor('pw2', 'salt2');
const EX = epochKeysFor('lost', 'salt-x');
const NEW_KEY = fakeDerive('pw2')('salt2');
const DOT = { dev: 3, ms: 60_000, c: 0 };
const PW1 = passwordKey('e1');
const PW2 = passwordKey('e2');
const NAME1 = regKey(TBL.entries, 'e1', 'name');
const DEAD_LIFE = regKey(TBL.entries, 'gone', LIFE_REG);
const DEAD_NAME = regKey(TBL.entries, 'gone', 'name');

function vaultAtE1(): SyncState {
  let s = makeState({
    current: E1,
    records: [recordFor(E0, null, 'salt0', rand), recordFor(E1, E0, 'salt1', rand)],
    wraps: [createWrap(E1, E0, rand)],
  });
  s = withRegister(s, PW1, [secretSib(PW1, 'alpha', E1, rand, 1, 100)]);
  s = withRegister(s, PW2, [secretSib(PW2, 'x', E1, rand, 1, 100), secretSib(PW2, 'y', E1, rand, 2, 200)]);
  s = withRegister(s, NAME1, [appSib(1, 100, 'Server', vhashOfValue(NAME1, 'Server'))]);
  s = withRegister(s, DEAD_LIFE, [appSib(2, 300, LIFE_DEAD, vhashOfValue(DEAD_LIFE, LIFE_DEAD))]);
  return withRegister(s, DEAD_NAME, [appSib(1, 100, 'Old', vhashOfValue(DEAD_NAME, 'Old'))]);
}

function change(state: SyncState, erase = false) {
  const ring = buildKeyRing(state, E1, LINEAGE);
  return changePassword(
    { state, ring, newKey: NEW_KEY, newSalt: 'salt2', dot: DOT, eraseRecentlyDeleted: erase },
    testContext(ring, 70_000),
  );
}

describe('changePassword (new build, 4.8 steps 1-6)', () => {
  it('adds epoch E2 with parent E1, a fresh verification token and a valid wrap (E2, E1)', () => {
    const res = change(vaultAtE1());
    expect(res.epoch).toMatchObject({ epochId: E2.epochId, parent: E1.epochId, salt: 'salt2', createdMs: 70_000 });
    expect(verifyKey(E2.kEpoch, res.epoch.verification ?? '')).toBe(true);
    expect(res.state.epochs.get(E2.epochId)).toEqual(res.epoch);
    const wrap = [...res.state.wraps.values()].find((w) => w.epochId === E2.epochId);
    expect(wrap && unwrapValidated(wrap, E2.kEpoch)?.equals(E1.kEpoch)).toBe(true);
    expect(res.ring.current.epochId).toBe(E2.epochId);
    expect([...res.ring.byEpoch.keys()].sort()).toEqual([E0.epochId, E1.epochId, E2.epochId].sort());
  });

  it('writes the epoch register with the given dot, replacing every sibling, and no content dots', () => {
    const before = vaultAtE1();
    const res = change(before);
    expect(currentEpochId(res.state)).toBe(E2.epochId);
    const sibs = getRegister(res.state, epochRegKey())?.sibs ?? [];
    expect(sibs.map((s) => [s.dev, s.ms, s.c, s.value])).toEqual([[DOT.dev, DOT.ms, DOT.c, E2.epochId]]);
    expect(res.state.vv.get(DOT.dev)).toEqual({ ms: DOT.ms, c: DOT.c });
    expect([...res.state.vv.keys()].sort()).toEqual([...new Set([...before.vv.keys(), DOT.dev])].sort());
    expect(getRegister(res.state, NAME1)).toBe(getRegister(before, NAME1));
  });

  it('re-encrypts every secret under the new key with keyed vhashes, keeping conflicts', () => {
    const res = change(vaultAtE1());
    const only2 = ringOf(E2);
    const a = getRegister(res.state, PW1)?.sibs[0];
    expect(a && readSecret(a.value as Uint8Array, only2)).toEqual({ kind: 'current', plaintext: 'alpha' });
    expect(a?.vhash).toBe(vhashOfSecret(PW1, 'alpha', E2.kSync));
    const pair = getRegister(res.state, PW2)?.sibs ?? [];
    expect(pair.map((s) => [s.dev, s.ms])).toEqual([[1, 100], [2, 200]]);
    expect(pair.map((s) => readSecret(s.value as Uint8Array, only2))).toEqual([
      { kind: 'current', plaintext: 'x' },
      { kind: 'current', plaintext: 'y' },
    ]);
  });

  it('redacts every superseded epoch', () => {
    const res = change(vaultAtE1());
    expect(res.state.epochs.get(E1.epochId)).toMatchObject({ salt: null, verification: null });
    expect(res.state.epochs.get(E0.epochId)).toMatchObject({ salt: null, verification: null });
    expect(res.state.epochs.get(E2.epochId)?.verification).not.toBeNull();
  });

  it('keeps old salts while undecryptable siblings remain', () => {
    const lostCt = encryptSecret('lost', EX, rand);
    const s = withRegister(vaultAtE1(), passwordKey('e7'), [appSib(1, 100, lostCt, 'aa'.repeat(16), SIB_UNDECRYPTABLE)]);
    const res = change(s);
    expect(res.state.epochs.get(E1.epochId)).toMatchObject({ salt: 'salt1', verification: null });
    expect(getRegister(res.state, passwordKey('e7'))?.sibs[0].flags).toBe(SIB_UNDECRYPTABLE);
  });

  it('optionally erases Recently deleted', () => {
    const kept = change(vaultAtE1(), false);
    expect(getRegister(kept.state, DEAD_NAME)?.sibs[0].value).toBe('Old');
    const erased = change(vaultAtE1(), true);
    const name = getRegister(erased.state, DEAD_NAME)?.sibs[0];
    expect(name?.flags ?? 0).toBe(SIB_REDACTED);
    expect(name?.value).toBeNull();
    expect(getRegister(erased.state, DEAD_LIFE)?.sibs[0].value).toBe(LIFE_DEAD);
  });

  it('refuses a ring of another epoch and a key of an existing epoch', () => {
    const s = vaultAtE1();
    const ctx = testContext(ringOf(E0));
    const base = { state: s, newKey: NEW_KEY, newSalt: 'salt2', dot: DOT, eraseRecentlyDeleted: false };
    expect(() => changePassword({ ...base, ring: ringOf(E0) }, ctx)).toThrow(SyncCoreError);
    const reuse = { ...base, ring: ringOf(E1), newKey: fakeDerive('pw0')('salt0') };
    expect(() => changePassword(reuse, testContext(ringOf(E1)))).toThrow(/existing epoch/);
  });

  it('wraps are union-set members keyed by their bytes', () => {
    const res = change(vaultAtE1());
    for (const [k, w] of res.state.wraps) expect(k).toBe(wrapKeyStr(w));
  });
});
