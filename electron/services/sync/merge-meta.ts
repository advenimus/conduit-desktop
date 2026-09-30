/**
 * State-level merge of everything that is not a register (spec 4.5): version vector, device
 * records, graves, key epochs and wraps. Every function returns its first argument itself
 * when the second adds nothing, so merge(W, S) keeps W's maps. Import through merge.ts.
 */

import { compareNum, compareStr, vvDominates, vvJoin } from './sibling.js';
import type { Dev, DevRecord, EpochRecord, Grave, VersionVector, WrapRecord } from './types.js';

/** Graves per row: redacted wins, else the larger died dot (ms, c, dev). A max, so a join. */
export function mergeGrave(a: Grave | null, b: Grave | null): Grave | null {
  if (a === null) return b;
  if (b === null || a === b) return a;
  const order =
    compareNum(Number(a.redacted), Number(b.redacted)) ||
    compareNum(a.diedMs, b.diedMs) ||
    compareNum(a.diedC, b.diedC) ||
    compareNum(a.diedDev, b.diedDev);
  return order >= 0 ? a : b;
}

/** Pointwise max; returns an input map itself when it already dominates the other. */
export function mergeVv(a: VersionVector, b: VersionVector): VersionVector {
  if (a === b || vvDominates(a, b)) return a;
  if (vvDominates(b, a)) return b;
  return vvJoin(a, b);
}

/** Same dev on both sides: the record with the smaller deviceUuid, then smaller startedMs. */
function compareDevRecords(x: DevRecord, y: DevRecord): number {
  return compareStr(x.deviceUuid, y.deviceUuid) || compareNum(x.startedMs, y.startedMs);
}

export function mergeDevs(a: ReadonlyMap<Dev, DevRecord>, b: ReadonlyMap<Dev, DevRecord>): ReadonlyMap<Dev, DevRecord> {
  if (a === b || b.size === 0) return a;
  let out: Map<Dev, DevRecord> | null = null;
  for (const [dev, rb] of b) {
    const ra = a.get(dev);
    if (ra === rb || (ra !== undefined && compareDevRecords(ra, rb) <= 0)) continue;
    out ??= new Map(a);
    out.set(dev, rb);
  }
  return out ?? a;
}

/** null wins (redaction); two different non-null texts resolve to the smaller one. */
function nullWins(x: string | null, y: string | null): string | null {
  if (x === null || y === null) return null;
  return compareStr(x, y) <= 0 ? x : y;
}

/** The non-null parent; two different parents resolve to the smaller id (never expected). */
function nonNullParent(x: string | null, y: string | null): string | null {
  if (x === null) return y;
  if (y === null) return x;
  return compareStr(x, y) <= 0 ? x : y;
}

function sameEpoch(x: EpochRecord, y: EpochRecord): boolean {
  return x.parent === y.parent && x.salt === y.salt && x.verification === y.verification && x.createdMs === y.createdMs;
}

export function mergeEpochRecord(x: EpochRecord, y: EpochRecord): EpochRecord {
  if (x === y) return x;
  const merged: EpochRecord = {
    epochId: x.epochId,
    parent: nonNullParent(x.parent, y.parent),
    salt: nullWins(x.salt, y.salt),
    verification: nullWins(x.verification, y.verification),
    createdMs: Math.min(x.createdMs, y.createdMs),
  };
  if (sameEpoch(merged, x)) return x;
  return sameEpoch(merged, y) ? y : merged;
}

export function mergeEpochs(
  a: ReadonlyMap<string, EpochRecord>,
  b: ReadonlyMap<string, EpochRecord>,
): ReadonlyMap<string, EpochRecord> {
  if (a === b || b.size === 0) return a;
  let out: Map<string, EpochRecord> | null = null;
  for (const [id, rb] of b) {
    const ra = a.get(id);
    const next = ra === undefined ? rb : mergeEpochRecord(ra, rb);
    if (next === ra) continue;
    out ??= new Map(a);
    out.set(id, next);
  }
  return out ?? a;
}

/** Union set keyed by wrapKeyStr. */
export function mergeWraps(
  a: ReadonlyMap<string, WrapRecord>,
  b: ReadonlyMap<string, WrapRecord>,
): ReadonlyMap<string, WrapRecord> {
  if (a === b || b.size === 0) return a;
  let out: Map<string, WrapRecord> | null = null;
  for (const [k, w] of b) {
    if (a.has(k)) continue;
    out ??= new Map(a);
    out.set(k, w);
  }
  return out ?? a;
}
