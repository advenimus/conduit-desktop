/**
 * Key rings and the epoch graph (spec 4.8): the ring of a current epoch plus every epoch
 * reachable through VALID wraps (BFS), parent-chain ancestry, structural wrap paths, and who
 * changed the password last (the epoch register's provisional dot). Import through key-epoch.ts.
 */

import { EPOCH_REG, epochRegKey } from './catalog.js';
import { deriveEpochKeys } from './hashing.js';
import { unwrapValidated, verifyKey, ringOrder } from './key-epoch-crypto.js';
import { currentEpochId, getRegister, provisional, wrapKeyStr } from './state-view.js';
import { PSEUDO_DEV, SyncCoreError } from './types.js';
import type { EpochKeys, KeyRing, SyncContext, SyncState, WrapRecord } from './types.js';

/** wrapping epoch -> its wraps, deduplicated and in a deterministic order. */
function indexWraps(wraps: Iterable<WrapRecord>): Map<string, WrapRecord[]> {
  const unique = new Map<string, WrapRecord>();
  for (const w of wraps) unique.set(wrapKeyStr(w), w);
  const index = new Map<string, WrapRecord[]>();
  for (const k of [...unique.keys()].sort()) {
    const w = unique.get(k) as WrapRecord;
    const list = index.get(w.epochId);
    if (list) list.push(w);
    else index.set(w.epochId, [w]);
  }
  return index;
}

function ringFromWraps(
  current: EpochKeys,
  wraps: Iterable<WrapRecord>,
  lineageId: string,
  seed?: ReadonlyMap<string, EpochKeys>,
): KeyRing {
  const byEpoch = new Map<string, EpochKeys>(seed ?? []);
  byEpoch.set(current.epochId, current);
  const index = indexWraps(wraps);
  const queue = [...byEpoch.keys()];
  for (let i = 0; i < queue.length; i++) {
    const wrapper = byEpoch.get(queue[i]) as EpochKeys;
    for (const wrap of index.get(queue[i]) ?? []) {
      if (byEpoch.has(wrap.targetEpoch)) continue;
      const key = unwrapValidated(wrap, wrapper.kEpoch);
      if (key === null) continue;
      byEpoch.set(wrap.targetEpoch, deriveEpochKeys(key, lineageId));
      queue.push(wrap.targetEpoch);
    }
  }
  return { current, byEpoch };
}

/**
 * Ring of `current` plus every epoch reachable from it through valid wraps in `state` (BFS).
 * `byEpoch` includes the current epoch itself, so lookups by epoch id are uniform.
 */
export function buildKeyRing(state: SyncState, current: EpochKeys, lineageId: string): KeyRing {
  return ringFromWraps(current, state.wraps.values(), lineageId);
}

/** Same ring plus every epoch that becomes reachable through `wraps` (e.g. the absorbed file's). */
export function extendRing(ring: KeyRing, wraps: Iterable<WrapRecord>, lineageId: string): KeyRing {
  return ringFromWraps(ring.current, wraps, lineageId, ring.byEpoch);
}

/** Ring over the wraps of several states (validated), for callers that hold one key. */
export function ringOverStates(current: EpochKeys, states: readonly SyncState[], lineageId: string): KeyRing {
  return ringFromWraps(current, states.flatMap((s) => [...s.wraps.values()]), lineageId);
}

/** Context helper: builds the ring for ctx from W's state after unlock. */
export function ringForContext(state: SyncState, key: Buffer, ctx: Pick<SyncContext, 'lineageId'>): KeyRing {
  return buildKeyRing(state, deriveEpochKeys(key, ctx.lineageId), ctx.lineageId);
}

/** The ring key that opens a vault_meta verification token (G2 key check), or null. */
export function findKeyForVerification(ring: KeyRing, verificationB64: string): EpochKeys | null {
  return ringOrder(ring).find((keys) => verifyKey(keys.kEpoch, verificationB64)) ?? null;
}

/** true when `ancestor` is on the parent chain of `descendant` in state.epochs (strict, cycle-safe). */
export function isAncestorEpoch(state: SyncState, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>([descendant]);
  let cur = state.epochs.get(descendant)?.parent ?? null;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = state.epochs.get(cur)?.parent ?? null;
  }
  return false;
}

/**
 * Structural (unvalidated) wrap path from `from` to `to`. Only a hint for which side must
 * enter a password; key material always comes from validated rings.
 */
export function wrapPathExists(wraps: Iterable<WrapRecord>, from: string, to: string): boolean {
  if (from === to) return true;
  const edges = new Map<string, Set<string>>();
  for (const w of wraps) {
    const set = edges.get(w.epochId) ?? new Set<string>();
    set.add(w.targetEpoch);
    edges.set(w.epochId, set);
  }
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Current epoch id of a state; a synced state without one is corrupt. */
export function requireCurrentEpoch(state: SyncState, which: string): string {
  const id = currentEpochId(state);
  if (id === null) throw new SyncCoreError('CORRUPT_STATE', `${which} state has no current key epoch`);
  return id;
}

export interface EpochChange {
  readonly deviceUuid: string | null;
  readonly ms: number;
}

/** Who wrote the current epoch and when: the epoch register's provisional dot (pseudo dots have no device). */
export function epochChangeInfo(state: SyncState): EpochChange {
  const reg = getRegister(state, epochRegKey());
  const top = reg ? provisional(EPOCH_REG, reg.sibs) : null;
  if (top === null) return { deviceUuid: null, ms: 0 };
  if (top.dev === PSEUDO_DEV) return { deviceUuid: null, ms: top.ms };
  return { deviceUuid: state.devs.get(top.dev)?.deviceUuid ?? null, ms: top.ms };
}
