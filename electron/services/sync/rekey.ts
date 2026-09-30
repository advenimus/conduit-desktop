/**
 * Master-password changes (spec 4.8): the new-build change as one W transaction (re-encrypt
 * everything, new epoch with parent and wrap, epoch register write, redaction of the old
 * epoch, optional erase of Recently deleted), and the legacy flow for a password changed by
 * desktop 0.17 or older (rekey-legacy.ts). Content and vault_meta follow through materialize.
 * Pure over state; the caller saves.
 */

import { epochRegKey } from './catalog.js';
import { applyLocalWrites, prepareWrite } from './capture-local.js';
import { deriveEpochKeys, epochIdOf, makeImplicitProvider } from './hashing.js';
import {
  addEpochRecord,
  buildKeyRing,
  createWrap,
  makeEpochRecord,
  makeVerificationToken,
  redactSuperseded,
  reencryptState,
  requireCurrentEpoch,
} from './key-epoch.js';
import { emptyRecentlyDeleted } from './tombstones.js';
import { SyncCoreError } from './types.js';
import type { AppDot, EpochKeys, EpochRecord, KeyRing, SyncContext, SyncState } from './types.js';
import { SYNC_LOG_PREFIX, type Kdf } from './host.js';

export const INVALID_PASSWORD_MESSAGE = 'Invalid master password';

export { absorbLegacyPasswordChange } from './rekey-legacy.js';
export type { LegacyPasswordChangeInput, LegacyPasswordChangeResult } from './rekey-legacy.js';

export interface ChangePasswordInput {
  readonly state: SyncState;
  readonly ring: KeyRing;
  /** PBKDF2(newPassword, newSalt). */
  readonly newKey: Buffer;
  /** base64, as vault_meta stores it. */
  readonly newSalt: string;
  /** Dot for the epoch register write (interactive). */
  readonly dot: AppDot;
  /** "Also permanently delete items in Recently deleted". */
  readonly eraseRecentlyDeleted: boolean;
}

export interface ChangePasswordResult {
  readonly state: SyncState;
  readonly ring: KeyRing;
  readonly epoch: EpochRecord;
}

/** The ring must be the state's: its current key is the state's current epoch. */
function requireRingOf(state: SyncState, ring: KeyRing, ctx: SyncContext): EpochKeys {
  if (ctx.lineageId !== state.lineageId) {
    throw new SyncCoreError('INVARIANT', 'the sync context belongs to another lineage');
  }
  if (requireCurrentEpoch(state, 'working') !== ring.current.epochId) {
    throw new SyncCoreError('KEY_MISMATCH', 'the key ring does not belong to the current epoch');
  }
  return ring.current;
}

/** Step 4: `_sync/key/epoch` = new epoch id, interactive (replace-all), no rule R. */
function writeEpochRegister(state: SyncState, e2: EpochKeys, dot: AppDot, ctx: SyncContext): SyncState {
  const write = prepareWrite(epochRegKey(), { value: e2.epochId }, ctx, 'replace-all');
  const att = { kind: 'local', dot, interactive: true } as const;
  return applyLocalWrites(state, [write], att, ctx, makeImplicitProvider(e2.kSync), { ruleR: false }).state;
}

/** 4.8: `password` must derive the current epoch's key from its salt; throws INVALID_PASSWORD_MESSAGE. */
export function verifyCurrentPassword(state: SyncState, ring: KeyRing, kdf: Kdf, password: string): void {
  const epoch = state.epochs.get(ring.current.epochId);
  if (epoch === undefined || epoch.salt === null) throw new Error(`${SYNC_LOG_PREFIX} the current key epoch has no salt`);
  if (epochIdOf(kdf.deriveKey(password, epoch.salt)) !== ring.current.epochId) throw new Error(INVALID_PASSWORD_MESSAGE);
}

/**
 * New-build password change (4.8 steps 1-6): re-encrypts every secret sibling under the new
 * key (keyed vhashes recomputed, pids unchanged), adds epoch E2 (parent E1) and the wrap
 * (E2, E1), writes the epoch register with `input.dot` (the only new dot), then redacts E1
 * and optionally erases Recently deleted. vault_meta salt and verification follow through
 * materialize. Returns the new ring (E2 current, E1 and its ancestors reachable).
 */
export function changePassword(input: ChangePasswordInput, ctx: SyncContext): ChangePasswordResult {
  const e1 = requireRingOf(input.state, input.ring, ctx);
  const e2 = deriveEpochKeys(input.newKey, input.state.lineageId);
  if (input.state.epochs.has(e2.epochId)) {
    throw new SyncCoreError('KEY_MISMATCH', 'the new password derives the key of an existing epoch');
  }
  const reencrypted = reencryptState(input.state, input.ring, e2, { randomBytes: ctx.randomBytes }).state;
  const verification = makeVerificationToken(e2, ctx.randomBytes);
  const epoch = makeEpochRecord(e2, e1.epochId, input.newSalt, verification, ctx.now());
  const withEpoch = addEpochRecord(reencrypted, epoch, [createWrap(e2, e1, ctx.randomBytes)]);
  const ring = buildKeyRing(withEpoch, e2, input.state.lineageId);
  const written = writeEpochRegister(withEpoch, e2, input.dot, { ...ctx, keys: ring });
  const redacted = redactSuperseded(written, ring);
  const state = input.eraseRecentlyDeleted ? emptyRecentlyDeleted(redacted) : redacted;
  return { state, ring, epoch };
}
