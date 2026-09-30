/**
 * Step 4 of the unlock sequence (spec 4.8 unlock policy, 6.3, 12 rows 59/64): the typed or
 * biometric password is checked against the peeked S and W's state before anything is
 * written or leased. A typo is the plain 'Invalid master password'; an ancestor epoch's
 * password is VAULT_PASSWORD_CHANGED_ELSEWHERE (the biometric entry is deleted); a newer
 * epoch that W cannot reach through a wrap needs the previous password once.
 */

import { epochIdOf } from '../sync/hashing.js';
import { currentEpochId, decideUnlock, epochChangeInfo, verifyKey, type FileKeyMeta } from '../sync/key-epoch.js';
import type { SyncState, UnlockDecision } from '../sync/types.js';
import type { OpenContext } from './open-deps.js';
import { changedElsewhereError, INVALID_PASSWORD_MESSAGE } from './open-errors.js';
import type { SharedView } from './open-peek.js';

export type OkDecision = Extract<UnlockDecision, { ok: true }>;

export interface AcceptedUnlock {
  readonly decision: OkDecision;
  /** The key the replica is opened with. */
  readonly key: Buffer;
  /** W's current key from previousPassword ('needs-wrap', optionally 'legacy-change'), else null. */
  readonly previousKey: Buffer | null;
  /** A legacy change on a pre-sync S: W opened under its own key; the engine adopts the change after the first cycle. */
  readonly legacyChangeAfterOpen?: boolean;
}

export interface PasswordInputs {
  readonly lineageId: string;
  readonly s: SharedView;
  readonly w: SyncState | null;
}

function unlockView(s: SharedView): { readonly state: SyncState | null; readonly meta: FileKeyMeta } | null {
  if (s.kind === 'synced') return { state: s.file.state, meta: s.meta };
  if (s.kind === 'presync') return { state: null, meta: s.meta };
  return null;
}

function deviceName(ctx: OpenContext, p: PasswordInputs, uuid: string | null): string | null {
  if (uuid === null) return null;
  for (const state of [p.s.kind === 'synced' ? p.s.file.state : null, p.w]) {
    if (state === null) continue;
    const name = ctx.c.readPresence(state, uuid)?.value.name;
    if (name !== undefined && name.length > 0) return name;
  }
  return null;
}

/** Step 4 for a shared vault; throws the matching error, never writes. */
export function verifySharedPassword(ctx: OpenContext, p: PasswordInputs): AcceptedUnlock {
  const out = decideUnlock({
    lineageId: p.lineageId,
    deriveFromSalt: (salt) => ctx.kdf(ctx.input.password, salt),
    w: p.w,
    s: unlockView(p.s),
  });
  const d = out.decision;
  if (!d.ok) {
    if (d.reason === 'wrong-password') throw new Error(INVALID_PASSWORD_MESSAGE);
    throw changedElsewhereError({
      changedByDeviceName: deviceName(ctx, p, d.changedByDeviceUuid),
      changedMs: d.changedMs,
      needsPreviousPassword: false,
      deleteBiometric: ctx.input.source === 'biometric_unlock',
    });
  }
  if (out.key === null) throw new Error('[vault-session] open: the unlock policy accepted a password without a key');
  return withPreviousKey(ctx, p, { decision: d, key: out.key, previousKey: null });
}

function withPreviousKey(ctx: OpenContext, p: PasswordInputs, accepted: AcceptedUnlock): AcceptedUnlock {
  const via = accepted.decision.via;
  if (via === 'needs-wrap') return { ...accepted, previousKey: previousKeyOrAsk(ctx, p) };
  if (via !== 'legacy-change') return accepted;
  if (p.s.kind === 'synced' || p.w === null) {
    // The previous password is optional here: without it W's unpublished secrets become undecryptable siblings.
    const given = ctx.input.previousPassword !== null && p.w !== null;
    return given ? { ...accepted, previousKey: requirePreviousKey(ctx, p.w) } : accepted;
  }
  // A pre-sync S has no sync state to absorb at open: W opens under its own key, the first cycle pauses on the legacy change, then the engine adopts it (12 row 64).
  const previousKey = previousKeyOrAsk(ctx, p);
  const wEpoch = currentEpochId(p.w);
  if (wEpoch === null) throw new Error('[vault-session] open: the working copy has no current epoch');
  return { decision: { ok: true, epochId: wEpoch, via: 'w-current' }, key: previousKey, previousKey: null, legacyChangeAfterOpen: true };
}

function previousKeyOrAsk(ctx: OpenContext, p: PasswordInputs): Buffer {
  if (ctx.input.previousPassword === null) throw needsPrevious(ctx, p);
  return requirePreviousKey(ctx, p.w);
}

function needsPrevious(ctx: OpenContext, p: PasswordInputs): Error {
  const change = p.s.kind === 'synced' ? epochChangeInfo(p.s.file.state) : { deviceUuid: null, ms: 0 };
  return changedElsewhereError({
    changedByDeviceName: deviceName(ctx, p, change.deviceUuid),
    changedMs: change.ms,
    needsPreviousPassword: true,
    deleteBiometric: false,
  });
}

/** Key of W's current epoch from previousPassword; a wrong previous password is 'Invalid master password'. */
function requirePreviousKey(ctx: OpenContext, w: SyncState | null): Buffer {
  const password = ctx.input.previousPassword;
  const epochId = w === null ? null : currentEpochId(w);
  const salt = w !== null && epochId !== null ? (w.epochs.get(epochId)?.salt ?? null) : null;
  if (password === null || salt === null) throw new Error(INVALID_PASSWORD_MESSAGE);
  const key = ctx.kdf(password, salt);
  if (epochIdOf(key) !== epochId) throw new Error(INVALID_PASSWORD_MESSAGE);
  return key;
}

/** Step 4 for a private vault: PBKDF2 + the vault_meta verification token (no epochs involved). */
export function verifyPrivatePassword(ctx: OpenContext, meta: FileKeyMeta): Buffer {
  if (meta.salt === null || meta.verification === null) throw new Error(INVALID_PASSWORD_MESSAGE);
  const key = ctx.kdf(ctx.input.password, meta.salt);
  if (!verifyKey(key, meta.verification)) throw new Error(INVALID_PASSWORD_MESSAGE);
  return key;
}
