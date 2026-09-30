// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { decrypt, encrypt } from '../../vault/crypto.js';
import { epochIdOf, vhashOfSecret, vhashUndecryptable } from '../hashing.js';
import {
  addEpochRecord,
  buildKeyRing,
  createWrap,
  encryptSecret,
  findKeyForVerification,
  isAncestorEpoch,
  makeEpochRecord,
  makeVerificationToken,
  readSecret,
  redactSuperseded,
  reencryptState,
  ringForContext,
  tryOldPassword,
  unwrapValidated,
  verifyKey,
  VERIFICATION_PLAINTEXT,
} from '../key-epoch.js';
import { StateBuilder, getRegister, makeRegister } from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, TBL, type EpochKeys, type WrapRecord } from '../types.js';
import {
  LINEAGE,
  appSib,
  epochKeysFor,
  fakeDerive,
  makeState,
  passwordKey,
  pseudoSib,
  recordFor,
  ringOf,
  secretSib,
  seqRandom,
  withRegister,
} from './key-epoch-fixtures.js';

const rand = seqRandom();
const E0 = epochKeysFor('pw0', 'salt0');
const E1 = epochKeysFor('pw1', 'salt1');
const E2 = epochKeysFor('pw2', 'salt2');
const EX = epochKeysFor('lost', 'salt-x');

function tamper(wrap: WrapRecord): WrapRecord {
  const bytes = Buffer.from(wrap.wrap, 'hex');
  bytes[bytes.length - 20] ^= 0x01;
  return { ...wrap, wrap: bytes.toString('hex') };
}

function chainState(current: EpochKeys, wraps: WrapRecord[]) {
  return makeState({
    current,
    records: [recordFor(E0, null, 'salt0', rand), recordFor(E1, E0, 'salt1', rand), recordFor(E2, E1, 'salt2', rand)],
    wraps,
  });
}

describe('secret crypto (vault field format)', () => {
  it('is readable by vault/crypto and reads vault/crypto output', () => {
    const ct = encryptSecret('hunter2', E1, rand);
    expect(ct.length).toBe(12 + Buffer.byteLength('hunter2') + 16);
    expect(decrypt(ct, E1.kEpoch).toString('utf8')).toBe('hunter2');
    const legacy = encrypt(Buffer.from('from-0.17', 'utf8'), E1.kEpoch);
    expect(readSecret(legacy, ringOf(E1))).toEqual({ kind: 'current', plaintext: 'from-0.17' });
  });

  it('verifies tokens only under the right key', () => {
    const token = makeVerificationToken(E1, rand);
    expect(decrypt(Buffer.from(token, 'base64'), E1.kEpoch).toString('utf8')).toBe(VERIFICATION_PLAINTEXT);
    expect(verifyKey(E1.kEpoch, token)).toBe(true);
    expect(verifyKey(E2.kEpoch, token)).toBe(false);
    expect(verifyKey(E1.kEpoch, 'AAAA')).toBe(false);
    expect(verifyKey(E1.kEpoch, makeVerificationToken(E2, rand))).toBe(false);
  });

  it('applies the stale-key read order', () => {
    const ring = ringOf(E2, E1, E0);
    expect(readSecret(encryptSecret('now', E2, rand), ring)).toEqual({ kind: 'current', plaintext: 'now' });
    expect(readSecret(encryptSecret('old', E0, rand), ring)).toEqual({ kind: 'older', plaintext: 'old', epochId: E0.epochId });
    expect(readSecret(encryptSecret('lost', EX, rand), ring)).toEqual({ kind: 'undecryptable' });
  });

  it('tries every retained salt for "Enter old password"', () => {
    const ct = encryptSecret('secret', E1, rand);
    const calls: string[] = [];
    const derive = (salt: string): Buffer => {
      calls.push(salt);
      return fakeDerive('pw1')(salt);
    };
    const hit = tryOldPassword(ct, ['salt0', '', 'salt0', 'salt1'], derive);
    expect(hit?.plaintext).toBe('secret');
    expect(hit?.key.equals(E1.kEpoch)).toBe(true);
    expect(calls).toEqual(['salt0', 'salt1']);
    expect(tryOldPassword(ct, ['salt0'], fakeDerive('pw1'))).toBeNull();
  });

  it('rejects wrong key sizes and short nonces as programmer errors', () => {
    expect(() => verifyKey(Buffer.alloc(16), makeVerificationToken(E1, rand))).toThrow();
    expect(() => encryptSecret('x', E1, () => Buffer.alloc(4))).toThrow();
  });
});

describe('wrap validity (4.8, red team #34)', () => {
  const wrap = createWrap(E2, E1, rand);

  it('unwraps a valid wrap to the target key', () => {
    expect(wrap.epochId).toBe(E2.epochId);
    expect(wrap.targetEpoch).toBe(E1.epochId);
    expect(unwrapValidated(wrap, E2.kEpoch)?.equals(E1.kEpoch)).toBe(true);
  });

  it('ignores tampered bytes, wrong keys, relabeled AAD and bad hex', () => {
    expect(unwrapValidated(tamper(wrap), E2.kEpoch)).toBeNull();
    expect(unwrapValidated(wrap, E1.kEpoch)).toBeNull();
    expect(unwrapValidated({ ...wrap, targetEpoch: E0.epochId }, E2.kEpoch)).toBeNull();
    expect(unwrapValidated({ ...wrap, wrap: wrap.wrap.slice(1) }, E2.kEpoch)).toBeNull();
    expect(unwrapValidated({ ...wrap, wrap: 'zz' + wrap.wrap.slice(2) }, E2.kEpoch)).toBeNull();
    expect(unwrapValidated({ ...wrap, wrap: '' }, E2.kEpoch)).toBeNull();
  });

  it('rejects an authentic wrap whose key does not match the target check value', () => {
    const liar: EpochKeys = { ...E0, epochId: E1.epochId };
    const bad = createWrap(E2, liar, rand);
    expect(bad.targetEpoch).toBe(E1.epochId);
    expect(unwrapValidated(bad, E2.kEpoch)).toBeNull();
  });

  it('refuses to wrap an epoch under itself', () => {
    expect(() => createWrap(E1, E1, rand)).toThrow();
  });
});

describe('key ring (valid wraps only)', () => {
  const w21 = createWrap(E2, E1, rand);
  const w10 = createWrap(E1, E0, rand);

  it('reaches every ancestor through a chain of valid wraps', () => {
    const ring = buildKeyRing(chainState(E2, [w21, w10]), E2, LINEAGE);
    expect(ring.current).toBe(E2);
    expect([...ring.byEpoch.keys()].sort()).toEqual([E0.epochId, E1.epochId, E2.epochId].sort());
    expect(ring.byEpoch.get(E0.epochId)?.kSync.equals(E0.kSync)).toBe(true);
  });

  it('uses a valid wrap next to a tampered one, and nothing through a tampered one alone', () => {
    const both = buildKeyRing(chainState(E2, [tamper(w21), w21, w10]), E2, LINEAGE);
    expect(both.byEpoch.has(E0.epochId)).toBe(true);
    const onlyBad = buildKeyRing(chainState(E2, [tamper(w21), w10]), E2, LINEAGE);
    expect([...onlyBad.byEpoch.keys()]).toEqual([E2.epochId]);
  });

  it('terminates on wrap cycles and matches ringForContext', () => {
    const cyclic = chainState(E1, [w10, createWrap(E0, E1, rand)]);
    const ring = buildKeyRing(cyclic, E1, LINEAGE);
    expect(ring.byEpoch.size).toBe(2);
    const viaCtx = ringForContext(cyclic, E1.kEpoch, { lineageId: LINEAGE });
    expect([...viaCtx.byEpoch.keys()].sort()).toEqual([...ring.byEpoch.keys()].sort());
  });

  it('finds the ring key that opens a verification token (G2 key check)', () => {
    const ring = ringOf(E2, E1, E0);
    expect(findKeyForVerification(ring, makeVerificationToken(E0, rand))?.epochId).toBe(E0.epochId);
    expect(findKeyForVerification(ring, makeVerificationToken(EX, rand))).toBeNull();
  });
});

describe('isAncestorEpoch', () => {
  it('walks parent links strictly and survives cycles', () => {
    const s = chainState(E2, []);
    expect(isAncestorEpoch(s, E0.epochId, E2.epochId)).toBe(true);
    expect(isAncestorEpoch(s, E1.epochId, E2.epochId)).toBe(true);
    expect(isAncestorEpoch(s, E2.epochId, E0.epochId)).toBe(false);
    expect(isAncestorEpoch(s, E2.epochId, E2.epochId)).toBe(false);
    const child = addEpochRecord(s, makeEpochRecord(EX, E2.epochId, 'sx', 'vx', 0), []);
    expect(isAncestorEpoch(child, EX.epochId, E2.epochId)).toBe(false);
    expect(isAncestorEpoch(child, E0.epochId, EX.epochId)).toBe(true);
    const cyclic = makeState({
      current: E2,
      records: [makeEpochRecord(E1, E2.epochId, 's1', 'v1', 0), makeEpochRecord(E2, E1.epochId, 's2', 'v2', 0)],
    });
    expect(isAncestorEpoch(cyclic, E1.epochId, E2.epochId)).toBe(true);
    expect(isAncestorEpoch(cyclic, 'nope', E2.epochId)).toBe(false);
  });
});

describe('reencryptState', () => {
  const k1 = passwordKey('e1');
  const k2 = passwordKey('h1', TBL.history);
  const base = withRegister(
    withRegister(chainState(E1, []), k1, [secretSib(k1, 'alpha', E1, rand, 1, 100), secretSib(k1, 'beta', E1, rand, 2, 200)]),
    k2,
    [secretSib(k2, 'hist', E1, rand, 1, 100)],
  );

  it('returns the same state when everything is already under the target key', () => {
    const out = reencryptState(base, ringOf(E1), E1);
    expect(out.state).toBe(base);
    expect(out.undecryptable).toBe(0);
  });

  it('moves every secret to the new epoch and keeps identities', () => {
    const out = reencryptState(base, ringOf(E1), E2, { randomBytes: rand });
    const sibs = getRegister(out.state, k1)?.sibs ?? [];
    expect(sibs.map((s) => [s.dev, s.ms, s.c, s.pid])).toEqual([[1, 100, 0, ''], [2, 200, 0, '']]);
    expect(readSecret(sibs[0].value as Uint8Array, ringOf(E2))).toEqual({ kind: 'current', plaintext: 'alpha' });
    expect(sibs[1].vhash).toBe(vhashOfSecret(k1, 'beta', E2.kSync));
    const hist = getRegister(out.state, k2)?.sibs[0];
    expect(hist?.vhash).toBe(vhashOfSecret(k2, 'hist', E2.kSync));
    expect(out.state.epochs).toBe(base.epochs);
  });

  it('flags unreadable siblings (or only counts them) and recovers undecryptable ones', () => {
    const lostCt = encryptSecret('lost', EX, rand);
    const lost = appSib(3, 300, lostCt, vhashOfSecret(k1, 'lost', E1.kSync));
    const withLost = withRegister(base, k1, [...(getRegister(base, k1)?.sibs ?? []), lost]);
    const flagged = reencryptState(withLost, ringOf(E1), E2, { randomBytes: rand });
    const f = getRegister(flagged.state, k1)?.sibs.find((s) => s.dev === 3);
    expect(flagged.undecryptable).toBe(1);
    expect(f?.flags).toBe(SIB_UNDECRYPTABLE);
    expect(f?.vhash).toBe(vhashUndecryptable(lostCt));
    expect(f?.value).toBe(lostCt);

    const counted = reencryptState(withLost, ringOf(E1), E2, { randomBytes: rand, markUnreadable: false });
    expect(counted.undecryptable).toBe(1);
    expect(getRegister(counted.state, k1)?.sibs.find((s) => s.dev === 3)).toBe(lost);

    const recovered = reencryptState(flagged.state, ringOf(E2, EX), E2, { randomBytes: rand });
    const r = getRegister(recovered.state, k1)?.sibs.find((s) => s.dev === 3);
    expect(recovered.undecryptable).toBe(0);
    expect(r?.flags).toBe(0);
    expect(r?.vhash).toBe(vhashOfSecret(k1, 'lost', E2.kSync));
  });

  it('leaves redacted siblings alone, re-keys null values and drops mat', () => {
    const redacted = { ...appSib(4, 400, null, '0'.repeat(32)), flags: SIB_REDACTED };
    const cleared = secretSib(k1, null, E1, rand, 5, 500);
    const s = withRegister(base, k1, [redacted, cleared]);
    const out = reencryptState(s, ringOf(E1), E2, { randomBytes: rand });
    const sibs = getRegister(out.state, k1)?.sibs ?? [];
    expect(sibs[0]).toBe(redacted);
    expect(sibs[1].vhash).toBe(vhashOfSecret(k1, null, E2.kSync));
    expect(getRegister(out.state, k1)?.mat).toBeUndefined();
  });

  it('with verifyWith, re-keys only values that still match their stored vhash', () => {
    const stale = { ...secretSib(k1, 'changed-by-legacy', E1, rand, 1, 100), vhash: vhashOfSecret(k1, 'alpha', E1.kSync) };
    const s = withRegister(base, k1, [stale, secretSib(k1, 'beta', E1, rand, 2, 200)]);
    const out = reencryptState(s, ringOf(E2, E1), E2, { randomBytes: rand, verifyWith: E1, markUnreadable: false });
    const sibs = getRegister(out.state, k1)?.sibs ?? [];
    expect(sibs[0]).toBe(stale);
    expect(sibs[1].vhash).toBe(vhashOfSecret(k1, 'beta', E2.kSync));
  });

  it('keeps pseudo pids and pmem', () => {
    const pid = 'ef'.repeat(16);
    const ct = encryptSecret('genesis', E1, rand);
    const p = pseudoSib(0, pid, ct, vhashOfSecret(k1, 'genesis', E1.kSync));
    const s = withRegister(base, k1, [p], { ms: 0, ids: [pid] });
    const reg = getRegister(reencryptState(s, ringOf(E1), E2, { randomBytes: rand }).state, k1);
    expect(reg?.sibs[0].pid).toBe(pid);
    expect(reg?.pmem).toEqual({ ms: 0, ids: [pid] });
  });
});

describe('redactSuperseded (4.8)', () => {
  const wraps = [createWrap(E2, E1, rand), createWrap(E1, E0, rand)];
  const s = chainState(E2, wraps);
  const ring = buildKeyRing(s, E2, LINEAGE);

  it('nulls verification and salt of every reachable ancestor, never the current epoch', () => {
    const out = redactSuperseded(s, ring);
    expect(out.epochs.get(E1.epochId)).toMatchObject({ salt: null, verification: null, parent: E0.epochId });
    expect(out.epochs.get(E0.epochId)).toMatchObject({ salt: null, verification: null });
    expect(out.epochs.get(E2.epochId)).toEqual(s.epochs.get(E2.epochId));
    expect(redactSuperseded(out, ring)).toBe(out);
  });

  it('keeps salts while undecryptable siblings exist', () => {
    const k = passwordKey('e9');
    const und = appSib(1, 100, Buffer.alloc(40, 7), vhashUndecryptable(Buffer.alloc(40, 7)), SIB_UNDECRYPTABLE);
    const out = redactSuperseded(withRegister(s, k, [und]), ring);
    expect(out.epochs.get(E1.epochId)).toMatchObject({ salt: 'salt1', verification: null });
  });

  it('leaves epochs without a valid wrap path alone', () => {
    const out = redactSuperseded(chainState(E2, [wraps[0]]), buildKeyRing(chainState(E2, [wraps[0]]), E2, LINEAGE));
    expect(out.epochs.get(E1.epochId)?.verification).toBeNull();
    expect(out.epochs.get(E0.epochId)?.verification).not.toBeNull();
  });

  it('measures reach from the state own current epoch', () => {
    const atE1 = chainState(E1, wraps);
    const out = redactSuperseded(atE1, ring);
    expect(out.epochs.get(E1.epochId)?.verification).not.toBeNull();
    expect(out.epochs.get(E0.epochId)?.verification).toBeNull();
    expect(out.epochs.get(E2.epochId)?.verification).not.toBeNull();
  });
});

describe('reencryptState performance (13.3)', () => {
  const ENTRIES = 5_000;
  const BUDGET_MS = 300;

  it('re-keys 5,000 secrets and skips an already-aligned state well within budget', () => {
    const b = new StateBuilder(chainState(E1, []));
    for (let i = 0; i < ENTRIES; i++) {
      const k = passwordKey(`p${i}`);
      b.setRegister(makeRegister(k, [secretSib(k, `pw-${i}`, E1, rand)], null));
    }
    const s = b.build();
    let t = performance.now();
    expect(reencryptState(s, ringOf(E1), E1).state).toBe(s);
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
    t = performance.now();
    const moved = reencryptState(s, ringOf(E1), E2, { randomBytes: rand });
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
    expect(moved.undecryptable).toBe(0);
  });
});

describe('epoch ids', () => {
  it('uses the key check value as epoch id', () => {
    expect(E1.epochId).toBe(epochIdOf(E1.kEpoch));
    expect(() => makeEpochRecord(E1, E1.epochId, 's', 'v', 0)).toThrow();
  });
});
