/**
 * alignEpoch (spec 4.8), run before every merge: classifies the absorbed state S1 against W
 * (same, S older, S newer, legacy password change, concurrent change) and, when S1 is older,
 * re-encrypts it in memory up to W's epoch. Import through key-epoch.ts.
 */

import { verifyKey } from './key-epoch-crypto.js';
import { reencryptState } from './key-epoch-reencrypt.js';
import { epochChangeInfo, extendRing, isAncestorEpoch, requireCurrentEpoch, wrapPathExists } from './key-epoch-ring.js';
import { SyncCoreError } from './types.js';
import type { EpochRecord, EpochRelation, KeyRing, SyncState } from './types.js';

/** vault_meta salt and verification as read from the absorbed file's content. */
export interface FileKeyMeta {
  readonly salt: string | null;
  readonly verification: string | null;
}

export type AlignResult =
  /** same epoch, or S older and re-encrypted up to W's epoch in memory (no new dots). */
  | { readonly kind: 'proceed'; readonly state: SyncState; readonly relation: 'same' | 's-older' }
  /** S newer: pause merge and publish until the new password is entered. */
  | { readonly kind: 'pause-newer'; readonly sEpochId: string; readonly changedByDeviceUuid: string | null; readonly changedMs: number }
  | { readonly kind: 'legacy-change' }
  /** `[this device's epoch, the other epoch]`; the UI maps "keep this device's password" by position. */
  | { readonly kind: 'concurrent'; readonly epochIds: readonly [string, string] };

function differs(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

/** A legacy app rewrote vault_meta: its salt or verification no longer matches the recorded epoch. */
export function metaMismatch(rec: EpochRecord | undefined, meta: FileKeyMeta): boolean {
  if (rec === undefined) return false;
  return differs(rec.salt, meta.salt) || differs(rec.verification, meta.verification);
}

/**
 * Parent chains decide first. When neither epoch is an ancestor of the other, a wrap path
 * (for example the loser of a concurrent change wrapped under the winner) orders them.
 */
function structuralRelation(s: SyncState, sEpoch: string, w: SyncState, wEpoch: string): EpochRelation {
  if (sEpoch === wEpoch) return 'same';
  if (isAncestorEpoch(w, sEpoch, wEpoch)) return 's-older';
  if (isAncestorEpoch(s, wEpoch, sEpoch)) return 's-newer';
  const wraps = [...w.wraps.values(), ...s.wraps.values()];
  if (wrapPathExists(wraps, wEpoch, sEpoch)) return 's-older';
  if (wrapPathExists(wraps, sEpoch, wEpoch)) return 's-newer';
  return 'concurrent';
}

/** Relation table of 4.8 alignEpoch. */
export function epochRelation(s: SyncState, sMeta: FileKeyMeta, w: SyncState): EpochRelation {
  const sEpoch = requireCurrentEpoch(s, 'absorbed');
  const wEpoch = requireCurrentEpoch(w, 'working');
  if (metaMismatch(s.epochs.get(sEpoch), sMeta)) return 'legacy-change';
  return structuralRelation(s, sEpoch, w, wEpoch);
}

/**
 * A verification token re-encrypted under the SAME key (salt unchanged) is not a password
 * change; only a key we hold can tell.
 */
function sameKeyDespiteMeta(s1: SyncState, sEpoch: string, sMeta: FileKeyMeta, ring: KeyRing): boolean {
  const rec = s1.epochs.get(sEpoch);
  const keys = ring.byEpoch.get(sEpoch);
  if (rec === undefined || keys === undefined || sMeta.verification === null) return false;
  if (differs(rec.salt, sMeta.salt)) return false;
  return verifyKey(keys.kEpoch, sMeta.verification);
}

function proceedOlder(s1: SyncState, ring: KeyRing, current: KeyRing['current']): AlignResult {
  return { kind: 'proceed', state: reencryptState(s1, ring, current).state, relation: 's-older' };
}

function pauseNewer(s1: SyncState, sEpoch: string): AlignResult {
  const info = epochChangeInfo(s1);
  return { kind: 'pause-newer', sEpochId: sEpoch, changedByDeviceUuid: info.deviceUuid, changedMs: info.ms };
}

/**
 * alignEpoch(S1, W) of 4.8, run before every merge. `ring` is W's key ring (its current epoch
 * must be W's current epoch). S1's own wraps extend the ring for decryption, validated as usual.
 */
export function alignEpoch(s1: SyncState, sMeta: FileKeyMeta, w: SyncState, ring: KeyRing): AlignResult {
  const sEpoch = requireCurrentEpoch(s1, 'absorbed');
  const wEpoch = requireCurrentEpoch(w, 'working');
  if (ring.current.epochId !== wEpoch) {
    throw new SyncCoreError('KEY_MISMATCH', 'the key ring does not belong to the working state epoch');
  }
  const wide = extendRing(ring, s1.wraps.values(), w.lineageId);
  const legacy = metaMismatch(s1.epochs.get(sEpoch), sMeta) && !sameKeyDespiteMeta(s1, sEpoch, sMeta, wide);
  const relation = legacy ? 'legacy-change' : structuralRelation(s1, sEpoch, w, wEpoch);
  switch (relation) {
    case 'same':
      return { kind: 'proceed', state: s1, relation: 'same' };
    case 's-older':
      return proceedOlder(s1, wide, ring.current);
    case 's-newer':
      return pauseNewer(s1, sEpoch);
    case 'legacy-change':
      return { kind: 'legacy-change' };
    case 'concurrent':
      if (wide.byEpoch.has(sEpoch)) return proceedOlder(s1, wide, ring.current);
      return { kind: 'concurrent', epochIds: [wEpoch, sEpoch] };
  }
}
