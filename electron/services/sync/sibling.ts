/**
 * Sibling, dot, version-vector and pseudo-memory primitives (spec 4.1, 4.5).
 * Fully implemented and shared by every sync module; hlc.ts re-exports the comparators.
 */

import {
  PSEUDO_DEV,
  SIB_REDACTED,
  SIB_UNDECRYPTABLE,
  SIB_VALUE_UNKNOWN,
  type Dev,
  type Hlc,
  type Pmem,
  type Sibling,
  type SyncValue,
  type VersionVector,
} from './types.js';

export function compareNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  return compareNum(a.ms, b.ms) || compareNum(a.c, b.c);
}

export function isPseudo(s: Sibling): boolean {
  return s.dev === PSEUDO_DEV;
}

export function isRedacted(s: Sibling): boolean {
  return (s.flags & SIB_REDACTED) !== 0;
}

export function isUndecryptable(s: Sibling): boolean {
  return (s.flags & SIB_UNDECRYPTABLE) !== 0;
}

export function isValueUnknown(s: Sibling): boolean {
  return (s.flags & SIB_VALUE_UNKNOWN) !== 0;
}

/** Eligible to be provisional: not undecryptable, not redacted, and its value is known here (4.1). */
export function isEligible(s: Sibling): boolean {
  return (s.flags & (SIB_REDACTED | SIB_UNDECRYPTABLE | SIB_VALUE_UNKNOWN)) === 0;
}

/** The same identity without a value: kept so coverage and merge still see it (SIB_VALUE_UNKNOWN). */
export function withValueUnknown(s: Sibling): Sibling {
  if (isValueUnknown(s) && s.value === null) return s;
  return { ...s, value: null, flags: s.flags | SIB_VALUE_UNKNOWN };
}

/** identity(s) of spec 4.5: ("p", ms, pid) or ("a", dev, ms, c). */
export function identityKey(s: Sibling): string {
  return s.dev === PSEUDO_DEV ? `p:${s.ms}:${s.pid}` : `a:${s.dev}:${s.ms}:${s.c}`;
}

/** Canonical storage order: (dev, ms, c, pid) ascending, the sync_sibling primary-key order. */
export function compareIdentity(a: Sibling, b: Sibling): number {
  return compareNum(a.dev, b.dev) || compareNum(a.ms, b.ms) || compareNum(a.c, b.c) || compareStr(a.pid, b.pid);
}

/** Rank (4.1): (ms, c, dev, lt, pid) left to right; a positive result means `a` ranks higher. */
export function compareRank(a: Sibling, b: Sibling): number {
  return (
    compareNum(a.ms, b.ms) ||
    compareNum(a.c, b.c) ||
    compareNum(a.dev, b.dev) ||
    compareNum(a.lt, b.lt) ||
    compareStr(a.pid, b.pid)
  );
}

// ---------- Version vectors ----------

/** vv[dev] >= (ms, c). */
export function vvCovers(vv: VersionVector, dev: Dev, stamp: Hlc): boolean {
  const e = vv.get(dev);
  return e !== undefined && compareHlc(e, stamp) >= 0;
}

export function vvJoin(a: VersionVector, b: VersionVector): VersionVector {
  if (a === b || b.size === 0) return a;
  if (a.size === 0) return b;
  const out = new Map(a);
  for (const [dev, stamp] of b) {
    const cur = out.get(dev);
    if (cur === undefined || compareHlc(cur, stamp) < 0) out.set(dev, stamp);
  }
  return out;
}

/** a >= b pointwise (a has seen everything b has). */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  for (const [dev, stamp] of b) {
    if (!vvCovers(a, dev, stamp)) return false;
  }
  return true;
}

// ---------- Pseudo memory ----------

export function pmemCovers(pm: Pmem | null, s: Sibling): boolean {
  if (pm === null) return false;
  if (pm.ms !== s.ms) return pm.ms > s.ms;
  return pm.ids.includes(s.pid);
}

/** Larger ms wins; equal ms -> union of ids (4.5 joinPmem). */
export function pmemJoin(a: Pmem | null, b: Pmem | null): Pmem | null {
  if (a === null) return b;
  if (b === null || a === b) return a;
  if (a.ms !== b.ms) return a.ms > b.ms ? a : b;
  const ids = new Set(a.ids);
  let added = false;
  for (const id of b.ids) {
    if (!ids.has(id)) {
      ids.add(id);
      added = true;
    }
  }
  return added ? { ms: a.ms, ids: [...ids].sort() } : a;
}

export function pmemEquals(a: Pmem | null, b: Pmem | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ms === b.ms && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);
}

export function makePmem(ms: number, ids: Iterable<string>): Pmem {
  return { ms, ids: [...new Set(ids)].sort() };
}

// ---------- Value helpers ----------

export function valuesIdentical(a: SyncValue, b: SyncValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && Buffer.compare(a, b) === 0;
  }
  return a === b;
}

/** Deterministic total order over values: null < number < string < bytes. */
export function compareValues(a: SyncValue, b: SyncValue): number {
  const rank = (v: SyncValue): number => (v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return compareNum(ra, rb);
  if (typeof a === 'number' && typeof b === 'number') return compareNum(a, b);
  if (typeof a === 'string' && typeof b === 'string') return compareStr(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b);
  return 0;
}

/** True when a copy's value hashes to its vhash (callers answer true when they cannot check). */
export type CopyCheck = (s: Sibling) => boolean;

/**
 * Picks the copy of one identity carried by two replicas (4.5 "redacted wins", plus a
 * deterministic tie-break so merge stays commutative and associative at the byte level):
 * redacted > value known > value consistent with its vhash (when `consistent` is given) >
 * decryptable > undecryptable, then smaller vhash, smaller value, non-null prev. A copy
 * without its value, or with one that is not the value its vhash describes, never replaces
 * one that has it.
 */
export function pickIdentityCopy(a: Sibling, b: Sibling, consistent?: CopyCheck): Sibling {
  if (a === b) return a;
  const order =
    compareNum(b.flags & SIB_REDACTED, a.flags & SIB_REDACTED) ||
    compareNum(a.flags & SIB_VALUE_UNKNOWN, b.flags & SIB_VALUE_UNKNOWN) ||
    compareConsistency(a, b, consistent) ||
    compareNum(a.flags & SIB_UNDECRYPTABLE, b.flags & SIB_UNDECRYPTABLE) ||
    compareStr(a.vhash, b.vhash) ||
    compareValues(a.value, b.value) ||
    comparePrev(a.prevVhash, b.prevVhash) ||
    compareNum(a.lt, b.lt);
  return order <= 0 ? a : b;
}

/** Consistent copies first. Two copies with the same value and vhash rank equal without hashing. */
function compareConsistency(a: Sibling, b: Sibling, consistent: CopyCheck | undefined): number {
  if (consistent === undefined || (a.vhash === b.vhash && valuesIdentical(a.value, b.value))) return 0;
  return compareNum(consistent(a) ? 0 : 1, consistent(b) ? 0 : 1);
}

function comparePrev(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStr(a, b);
}
