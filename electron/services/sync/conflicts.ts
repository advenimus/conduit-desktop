/**
 * The conflict queue (spec 4.10, 7): listConflicts is derived from the state on every call
 * (no stored queue), grouped by row, plus structural conflicts from the last materialization.
 * Resolutions are returned as LocalWrite lists that the caller applies with
 * capture-local.applyLocalWrites under one interactive dot: field choices, group A "keep
 * newest", edit-versus-delete, folder delete, cycles, bulk actions, undecryptable values,
 * [Keep both], and losing password plaintexts copied to password_history.
 *
 * Parts: conflicts-shared (context, walk, helpers), conflicts-list (queue), conflicts-copy
 * (history rows, keep-both copies), conflicts-resolve (resolutions). Key recovery and reveal
 * live here.
 */

import { requireDef } from './catalog.js';
import { findVersion } from './conflicts-shared.js';
import { deriveEpochKeys } from './hashing.js';
import { createWrap, readSecret, reencryptState, tryOldPassword } from './key-epoch.js';
import { compareStr, isRedacted, isUndecryptable } from './sibling.js';
import { StateBuilder } from './state-view.js';
import type { EpochKeys, KeyRing, RegKey, Sibling, SyncContext, SyncState } from './types.js';

export { CHANGED_BY_CONFLICT, MASTER_PASSWORD_TITLE, type ConflictContext } from './conflicts-shared.js';
export { deviceNamesFromPresence, hasConflict, listConflicts, snoozeKeyOf } from './conflicts-list.js';
export {
  discardUndecryptable,
  resolveAppearance,
  resolveBulk,
  resolveCycle,
  resolveEditDelete,
  resolveField,
  resolveFolderDelete,
} from './conflicts-resolve.js';

export interface RecoveredKey {
  /** State with a wrap (current, recovered) added and every secret the key opens re-encrypted. */
  readonly state: SyncState;
  readonly recovered: EpochKeys;
}

/** Every non-null salt the state still retains, sorted and unique (4.8 "Enter old password"). */
function retainedSalts(state: SyncState): string[] {
  const salts = new Set<string>();
  for (const e of state.epochs.values()) {
    if (e.salt !== null) salts.add(e.salt);
  }
  return [...salts].sort(compareStr);
}

function ringWith(ring: KeyRing, extra: EpochKeys): KeyRing {
  const byEpoch = new Map(ring.byEpoch);
  byEpoch.set(extra.epochId, extra);
  return { current: ring.current, byEpoch };
}

/**
 * [Enter old password] for one undecryptable version (4.8): trial-decrypt it with PBKDF2 of the
 * password for each retained salt. On success the recovered key is wrapped under the current
 * epoch and reencryptState turns every sibling it opens decryptable (same identities, no dot),
 * so the conflict stays visible with readable values. Null when no salt opens it.
 */
export function recoverUndecryptable(
  state: SyncState,
  key: RegKey,
  versionId: string,
  deriveFromSalt: (saltB64: string) => Buffer,
  ctx: SyncContext,
): RecoveredKey | null {
  if (!requireDef(key).secret) throw new Error(`recoverUndecryptable: ${key.reg} is not a secret`);
  const sib = findVersion(state, key, versionId);
  if (!isUndecryptable(sib) || !(sib.value instanceof Uint8Array)) {
    throw new Error('recoverUndecryptable: the version is not an undecryptable secret');
  }
  const found = tryOldPassword(sib.value, retainedSalts(state), deriveFromSalt);
  if (!found) return null;
  const recovered = deriveEpochKeys(found.key, state.lineageId);
  const current = ctx.keys.current;
  const b = new StateBuilder(state);
  if (recovered.epochId !== current.epochId) b.addWrap(createWrap(current, recovered, ctx.randomBytes));
  const next = reencryptState(b.build(), ringWith(ctx.keys, recovered), current, { randomBytes: ctx.randomBytes });
  return { state: next.state, recovered };
}

/** Decrypts one sibling's secret for the reveal button (vault unlocked); null if it cannot. */
export function revealSecret(sibling: Sibling, ring: KeyRing): string | null {
  if (isRedacted(sibling)) return null;
  if (sibling.value === null) return '';
  if (!(sibling.value instanceof Uint8Array)) return null;
  const read = readSecret(sibling.value, ring);
  return read.kind === 'undecryptable' ? null : read.plaintext;
}
