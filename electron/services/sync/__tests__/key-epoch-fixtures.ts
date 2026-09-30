// Shared fixtures for key-epoch.test.ts and rekey.test.ts (not a test file itself).
import { createHash } from 'node:crypto';
import { epochRegKey, regKey } from '../catalog.js';
import { deriveEpochKeys, vhashOfSecret, vhashOfValue } from '../hashing.js';
import { encryptSecret, makeEpochRecord, makeVerificationToken } from '../key-epoch.js';
import { StateBuilder, emptyState, makeRegister } from '../state-view.js';
import { TBL } from '../types.js';
import type { EpochKeys, EpochRecord, KeyRing, Pmem, RegKey, Sibling, SyncContext, SyncState, WrapRecord } from '../types.js';

export const LINEAGE = '6f1c1d3e-8b1e-4f7a-9d55-0c2f6a1b2c3d';
export const GENESIS = 'ab'.repeat(32);
export const EPOCH_DEV = 7;
export const EPOCH_MS = 1_000;
export const DEVICE_A = 'device-a';

/** Deterministic nonce source: every call returns fresh, distinct bytes. */
export function seqRandom(seed = 1): (n: number) => Buffer {
  let counter = seed;
  return (n: number) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i += 32) {
      createHash('sha256').update(`nonce:${counter++}`).digest().copy(out, i);
    }
    return out;
  };
}

/** Stand-in for PBKDF2(password, salt): fast and deterministic. */
export function fakeDerive(password: string): (saltB64: string) => Buffer {
  return (salt) => createHash('sha256').update(`${password}\u001f${salt}`).digest();
}

export function epochKeysFor(password: string, salt: string): EpochKeys {
  return deriveEpochKeys(fakeDerive(password)(salt), LINEAGE);
}

export function recordFor(
  keys: EpochKeys,
  parent: EpochKeys | null,
  salt: string,
  rand: (n: number) => Buffer,
): EpochRecord {
  return makeEpochRecord(keys, parent?.epochId ?? null, salt, makeVerificationToken(keys, rand), 0);
}

export function ringOf(current: EpochKeys, ...others: EpochKeys[]): KeyRing {
  const byEpoch = new Map<string, EpochKeys>([[current.epochId, current]]);
  for (const k of others) byEpoch.set(k.epochId, k);
  return { current, byEpoch };
}

export function appSib(dev: number, ms: number, value: Sibling['value'], vhash: string, flags = 0): Sibling {
  return { dev, ms, c: 0, pid: '', lt: 0, vhash, flags, value, prevVhash: null };
}

export function pseudoSib(ms: number, pid: string, value: Sibling['value'], vhash: string, flags = 0): Sibling {
  return { dev: 0, ms, c: 0, pid, lt: ms, vhash, flags, value, prevVhash: null };
}

export function passwordKey(rowId: string, tbl: 1 | 3 = TBL.entries): RegKey {
  return regKey(tbl, rowId, 'password');
}

export function secretSib(
  key: RegKey,
  plaintext: string | null,
  keys: EpochKeys,
  rand: (n: number) => Buffer,
  dev = 1,
  ms = 100,
): Sibling {
  const value = plaintext === null ? null : encryptSecret(plaintext, keys, rand);
  return appSib(dev, ms, value, vhashOfSecret(key, plaintext, keys.kSync));
}

export interface StateSpec {
  readonly current: EpochKeys;
  readonly records: readonly EpochRecord[];
  readonly wraps?: readonly WrapRecord[];
  readonly epochDev?: number;
  readonly epochMs?: number;
  readonly deviceUuid?: string;
}

/** A state whose `_sync/key/epoch` register holds `current` as one app sibling. */
export function makeState(spec: StateSpec): SyncState {
  const b = new StateBuilder(emptyState(LINEAGE, GENESIS, 0));
  for (const rec of spec.records) b.setEpoch(rec);
  for (const wrap of spec.wraps ?? []) b.addWrap(wrap);
  const dev = spec.epochDev ?? EPOCH_DEV;
  const ms = spec.epochMs ?? EPOCH_MS;
  const key = epochRegKey();
  b.setRegister(makeRegister(key, [appSib(dev, ms, spec.current.epochId, vhashOfValue(key, spec.current.epochId))], null));
  b.joinVv(dev, { ms, c: 0 });
  b.addDev({ dev, deviceUuid: spec.deviceUuid ?? DEVICE_A, startedMs: 0 });
  return b.build();
}

/** Adds (or replaces) an explicit register and covers its app dots in vv. */
export function withRegister(state: SyncState, key: RegKey, sibs: readonly Sibling[], pmem: Pmem | null = null): SyncState {
  const b = new StateBuilder(state);
  b.setRegister(makeRegister(key, sibs, pmem));
  for (const s of sibs) if (s.dev > 0) b.joinVv(s.dev, s);
  return b.build();
}

export function testContext(keys: KeyRing, now = 50_000, dev = 3): SyncContext {
  return {
    deviceUuid: DEVICE_A,
    lineageId: LINEAGE,
    dev,
    incarnation: 'cd'.repeat(16),
    keys,
    now: () => now,
    randomBytes: seqRandom(99),
  };
}
