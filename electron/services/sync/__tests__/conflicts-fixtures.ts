// Test-only fixtures for conflicts tests: real epoch keys, a SyncContext, sibling builders
// with real vhashes, and a helper that applies resolution writes under one interactive dot.
import { createHash } from 'node:crypto';
import { IMPLICIT_PMEM, regKey } from '../catalog.js';
import { applyLocalWrites } from '../capture-local.js';
import { deriveEpochKeys, makeImplicitProvider, vhashOfSecret, vhashOfValue } from '../hashing.js';
import { encryptSecret } from '../key-epoch.js';
import { StateBuilder, emptyState, makeRegister } from '../state-view.js';
import { TBL } from '../types.js';
import type {
  EpochKeys,
  ImplicitProvider,
  KeyRing,
  LocalWrite,
  Pmem,
  RegKey,
  Sibling,
  SyncContext,
  SyncState,
  SyncValue,
} from '../types.js';

export const LINEAGE = '0b7f3c9e-2a41-4d8b-9e6f-5c1d2b3a4e5f';
export const GENESIS = 'cd'.repeat(32);
export const NOW_MS = Date.UTC(2026, 8, 25, 12, 0, 0);
export const DEV_ME = 42;

/** Deterministic nonce source: every call returns fresh, distinct bytes. */
export function seqRandom(seed = 1): (n: number) => Buffer {
  let counter = seed;
  return (n: number) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i += 32) createHash('sha256').update(`r:${counter++}`).digest().copy(out, i);
    return out;
  };
}

/** Stand-in for PBKDF2(password, salt). */
export function fakeDerive(password: string): (saltB64: string) => Buffer {
  return (salt) => createHash('sha256').update(`${password}\u001f${salt}`).digest();
}

export function keysFor(password: string, salt: string): EpochKeys {
  return deriveEpochKeys(fakeDerive(password)(salt), LINEAGE);
}

export function ringOf(current: EpochKeys, ...others: EpochKeys[]): KeyRing {
  return { current, byEpoch: new Map([current, ...others].map((k) => [k.epochId, k])) };
}

export function makeCtx(keys: KeyRing, seed = 1): SyncContext {
  return {
    deviceUuid: 'device-me',
    lineageId: LINEAGE,
    dev: DEV_ME,
    incarnation: 'ab'.repeat(16),
    keys,
    now: () => NOW_MS,
    randomBytes: seqRandom(seed),
  };
}

export function implicitFor(ctx: SyncContext): ImplicitProvider {
  return makeImplicitProvider(ctx.keys.current.kSync);
}

export const entryKey = (rowId: string, reg: string): RegKey => regKey(TBL.entries, rowId, reg);
export const folderKey = (rowId: string, reg: string): RegKey => regKey(TBL.folders, rowId, reg);

export function app(key: RegKey, dev: number, ms: number, value: SyncValue, extra: Partial<Sibling> = {}): Sibling {
  return { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null, ...extra };
}

export function pseudo(key: RegKey, ms: number, pid: string, value: SyncValue, lt = ms): Sibling {
  return { dev: 0, ms, c: 0, pid, lt, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
}

export function secretApp(key: RegKey, dev: number, ms: number, plain: string | null, keys: EpochKeys, rand = seqRandom(ms)): Sibling {
  const value = plain === null ? null : encryptSecret(plain, keys, rand);
  return { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfSecret(key, plain, keys.kSync), flags: 0, value, prevVhash: null };
}

export interface RegSpec {
  readonly key: RegKey;
  readonly sibs: readonly Sibling[];
  readonly pmem?: Pmem | null;
}

/** A state holding the given explicit registers; vv covers every app sibling. */
export function stateOf(regs: readonly RegSpec[], extra?: (b: StateBuilder) => void): SyncState {
  const b = new StateBuilder(emptyState(LINEAGE, GENESIS, 0));
  for (const r of regs) {
    b.ensureRow({ tbl: r.key.tbl, rowId: r.key.rowId });
    b.setRegister(makeRegister(r.key, r.sibs, r.pmem === undefined ? IMPLICIT_PMEM : r.pmem));
    for (const s of r.sibs) if (s.dev > 0) b.joinVv(s.dev, s);
  }
  extra?.(b);
  return b.build();
}

/** Applies resolution writes the way the caller does: one interactive dot, rule R on. */
export function applyResolution(state: SyncState, writes: readonly LocalWrite[], ctx: SyncContext): SyncState {
  const dot = { dev: ctx.dev, ms: NOW_MS, c: 0 };
  return applyLocalWrites(state, writes, { kind: 'local', dot, interactive: true }, ctx, implicitFor(ctx)).state;
}
