/**
 * Key epochs (spec 4.8): epoch records with key-check-value ids, validated wraps
 * (AES-256-GCM, AAD epoch_id 1f target), the key ring reachable through valid wraps,
 * alignEpoch relations before every merge, re-encryption of a whole state between epochs,
 * redaction of superseded epochs, the unlock policy, and stale-key secret reads.
 * The implementation lives in key-epoch-*.ts; import it through this file.
 */

import { createWrap } from './key-epoch-crypto.js';
import { isAncestorEpoch } from './key-epoch-ring.js';
import { StateBuilder } from './state-view.js';
import { SyncCoreError, type EpochKeys, type EpochRecord, type SyncState, type WrapRecord } from './types.js';

export { currentEpochId } from './state-view.js';

export {
  EPOCH_KEY_LEN,
  VERIFICATION_PLAINTEXT,
  WRAP_NONCE_LEN,
  WRAP_TAG_LEN,
  createWrap,
  encryptSecret,
  makeVerificationToken,
  openSecret,
  openWithAny,
  readSecret,
  ringOrder,
  sealSecretBytes,
  tryOldPassword,
  unwrapValidated,
  verifyKey,
} from './key-epoch-crypto.js';
export type { OpenedSecret, SecretRead } from './key-epoch-crypto.js';

export {
  buildKeyRing,
  epochChangeInfo,
  extendRing,
  findKeyForVerification,
  isAncestorEpoch,
  requireCurrentEpoch,
  ringForContext,
  ringOverStates,
  wrapPathExists,
} from './key-epoch-ring.js';
export type { EpochChange } from './key-epoch-ring.js';

export { hasUndecryptable, reencryptState, redactSuperseded } from './key-epoch-reencrypt.js';
export type { ReencryptOptions, ReencryptResult } from './key-epoch-reencrypt.js';

export { alignEpoch, epochRelation, metaMismatch } from './key-epoch-align.js';
export type { AlignResult, FileKeyMeta } from './key-epoch-align.js';

export { decideUnlock } from './key-epoch-unlock.js';
export type { UnlockInput, UnlockOutcome } from './key-epoch-unlock.js';

/** Adds an epoch record (unless the state already has one for that id) and wraps. No dots. */
export function addEpochRecord(state: SyncState, record: EpochRecord, wraps: readonly WrapRecord[]): SyncState {
  const b = new StateBuilder(state);
  if (!state.epochs.has(record.epochId)) b.setEpoch(record);
  for (const wrap of wraps) b.addWrap(wrap);
  return b.build();
}

export function makeEpochRecord(
  keys: EpochKeys,
  parent: string | null,
  salt: string,
  verification: string,
  createdMs: number,
): EpochRecord {
  if (parent === keys.epochId) throw new Error('key-epoch: an epoch cannot be its own parent');
  return { epochId: keys.epochId, parent, salt, verification, createdMs };
}

/**
 * After a 'needs-wrap' unlock (4.8): a device holding both keys adds the wrap (newer, older)
 * that a device without the old key could not write, so W can be re-encrypted up to the newer
 * epoch and every device reaches the older key again. `lineage` is any state holding the
 * newer epoch's record (S); the wrap is added to `state` (W). No dots.
 */
export function linkMissingWrap(
  state: SyncState,
  lineage: SyncState,
  newer: EpochKeys,
  older: EpochKeys,
  randomBytes: (n: number) => Buffer,
): SyncState {
  if (!isAncestorEpoch(lineage, older.epochId, newer.epochId)) {
    throw new SyncCoreError('KEY_MISMATCH', 'key-epoch: the older epoch is not an ancestor of the newer one');
  }
  const b = new StateBuilder(state);
  b.addWrap(createWrap(newer, older, randomBytes));
  return b.build();
}
