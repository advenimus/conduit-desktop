/**
 * Unlock policy of spec 4.8: a typed or biometric password is accepted only when it derives
 * the key of W's current epoch; or of S's current epoch when that epoch reaches W's through
 * valid wraps (or there is no W); or the key matching S's vault_meta after a legacy password
 * change. A password that only opens a superseded epoch is rejected. When the password opens
 * S's current epoch, a descendant of W's, but no valid wrap links them yet (a legacy change
 * absorbed without the old key), the decision is 'needs-wrap': the caller supplies W's key and
 * adds the wrap (key-epoch.linkMissingWrap). Import through key-epoch.ts.
 */

import { deriveEpochKeys, epochIdOf } from './hashing.js';
import { metaMismatch, type FileKeyMeta } from './key-epoch-align.js';
import { EPOCH_KEY_LEN, verifyKey } from './key-epoch-crypto.js';
import { epochChangeInfo, isAncestorEpoch, ringOverStates, wrapPathExists, type EpochChange } from './key-epoch-ring.js';
import { currentEpochId } from './state-view.js';
import type { SyncState, UnlockDecision } from './types.js';

export interface UnlockInput {
  readonly lineageId: string;
  /** PBKDF2 of the typed password for a given base64 salt (injected; 600k iterations). */
  readonly deriveFromSalt: (saltB64: string) => Buffer;
  /** W's state, or null when this device has no W for the lineage yet. */
  readonly w: SyncState | null;
  /** Peeked S: its state (null when pre-sync) and its vault_meta key fields. */
  readonly s: { readonly state: SyncState | null; readonly meta: FileKeyMeta } | null;
}

export interface UnlockOutcome {
  readonly decision: UnlockDecision;
  /** The accepted epoch key (ok decisions only). */
  readonly key: Buffer | null;
}

const WRONG_PASSWORD: UnlockOutcome = { decision: { ok: false, reason: 'wrong-password' }, key: null };
const UNKNOWN_CHANGE: EpochChange = { deviceUuid: null, ms: 0 };

type Via = 'w-current' | 's-newer' | 'no-w' | 'legacy-change' | 'needs-wrap';

/** Everything the policy looks at, with PBKDF2 memoized per salt (each call costs ~0.5 s). */
class UnlockView {
  readonly w: SyncState | null;
  readonly s: SyncState | null;
  readonly meta: FileKeyMeta | null;
  readonly wEpoch: string | null;
  readonly sEpoch: string | null;
  /** S's vault_meta no longer matches its recorded epoch (a legacy app changed the password). */
  readonly sLegacy: boolean;
  /** S's current epoch is behind W's (parent chain or a wrap path), or lost to a legacy change. */
  readonly sSuperseded: boolean;
  private readonly lineageId: string;
  private readonly derive: (saltB64: string) => Buffer;
  private readonly keys = new Map<string, Buffer>();

  constructor(input: UnlockInput) {
    this.lineageId = input.lineageId;
    this.derive = input.deriveFromSalt;
    this.w = input.w;
    this.s = input.s?.state ?? null;
    this.meta = input.s?.meta ?? null;
    this.wEpoch = this.w ? currentEpochId(this.w) : null;
    this.sEpoch = this.s ? currentEpochId(this.s) : null;
    this.sLegacy = this.s !== null && this.meta !== null && this.sEpoch !== null && metaMismatch(this.s.epochs.get(this.sEpoch), this.meta);
    this.sSuperseded = this.sLegacy || this.sBehindW();
  }

  private sBehindW(): boolean {
    const { w, s, wEpoch, sEpoch } = this;
    if (w === null || s === null || wEpoch === null || sEpoch === null || wEpoch === sEpoch) return false;
    if (isAncestorEpoch(w, sEpoch, wEpoch)) return true;
    return wrapPathExists([...w.wraps.values(), ...s.wraps.values()], wEpoch, sEpoch);
  }

  keyFor(salt: string): Buffer {
    let key = this.keys.get(salt);
    if (key === undefined) {
      key = this.derive(salt);
      if (key.length !== EPOCH_KEY_LEN) throw new Error('key-epoch: deriveFromSalt must return a 32-byte key');
      this.keys.set(salt, key);
    }
    return key;
  }

  /** The key of `epochId` if its salt is known and the password derives it (key check value). */
  opens(state: SyncState, epochId: string): Buffer | null {
    const salt = state.epochs.get(epochId)?.salt ?? null;
    if (salt === null) return null;
    const key = this.keyFor(salt);
    return epochIdOf(key) === epochId ? key : null;
  }

  reaches(key: Buffer, target: string): boolean {
    const states = [this.s, this.w].filter((x): x is SyncState => x !== null);
    return ringOverStates(deriveEpochKeys(key, this.lineageId), states, this.lineageId).byEpoch.has(target);
  }

  isKnownEpoch(epochId: string): boolean {
    return (this.w?.epochs.has(epochId) ?? false) || (this.s?.epochs.has(epochId) ?? false);
  }
}

function accept(epochId: string, via: Via, key: Buffer): UnlockOutcome {
  return { decision: { ok: true, epochId, via }, key };
}

function acceptWCurrent(v: UnlockView): UnlockOutcome | null {
  if (v.w === null || v.wEpoch === null) return null;
  const key = v.opens(v.w, v.wEpoch);
  return key ? accept(v.wEpoch, 'w-current', key) : null;
}

function acceptSCurrent(v: UnlockView): UnlockOutcome | null {
  if (v.s === null || v.sEpoch === null || v.sEpoch === v.wEpoch || v.sSuperseded) return null;
  const key = v.opens(v.s, v.sEpoch);
  if (key === null) return null;
  if (v.w === null) return accept(v.sEpoch, 'no-w', key);
  if (v.wEpoch === null) return null;
  if (v.reaches(key, v.wEpoch)) return accept(v.sEpoch, 's-newer', key);
  if (isAncestorEpoch(v.s, v.wEpoch, v.sEpoch)) return accept(v.sEpoch, 'needs-wrap', key);
  return null;
}

/**
 * The key opening S's vault_meta: a pre-sync S with no W, or a legacy password change to an
 * unknown epoch. A key of a known older epoch (an old pre-sync copy) is superseded.
 */
function acceptMetaKey(v: UnlockView): UnlockOutcome | null {
  const meta = v.meta;
  if (meta === null || meta.salt === null || meta.verification === null) return null;
  const presync = v.s === null;
  if (!presync && !v.sLegacy) return null;
  const key = v.keyFor(meta.salt);
  if (!verifyKey(key, meta.verification)) return null;
  const epochId = epochIdOf(key);
  if (v.isKnownEpoch(epochId)) return epochId === v.wEpoch ? accept(epochId, 'w-current', key) : superseded(v);
  return accept(epochId, presync && v.w === null ? 'no-w' : 'legacy-change', key);
}

/** Epochs a password may match that the policy rejects as superseded. */
function supersededCandidates(v: UnlockView): { readonly state: SyncState; readonly epochId: string }[] {
  const out: { state: SyncState; epochId: string }[] = [];
  for (const state of [v.w, v.s]) {
    if (state === null) continue;
    for (const rec of state.epochs.values()) {
      if (rec.salt === null || rec.epochId === v.wEpoch) continue;
      if (rec.epochId === v.sEpoch && !v.sSuperseded) continue;
      out.push({ state, epochId: rec.epochId });
    }
  }
  return out;
}

/** The most recent password change we know of, for "changed on MacBook on Sep 24". */
function latestChange(v: UnlockView): EpochChange {
  // A legacy app's change is the newest one, and it records neither device nor time.
  if (v.sLegacy) return UNKNOWN_CHANGE;
  const changes: EpochChange[] = [];
  if (v.w !== null) changes.push(epochChangeInfo(v.w));
  if (v.s !== null) changes.push(epochChangeInfo(v.s));
  return changes.reduce((best, c) => (c.ms > best.ms ? c : best), UNKNOWN_CHANGE);
}

function superseded(v: UnlockView): UnlockOutcome {
  const change = latestChange(v);
  return {
    decision: { ok: false, reason: 'superseded', changedByDeviceUuid: change.deviceUuid, changedMs: change.ms },
    key: null,
  };
}

function rejectSuperseded(v: UnlockView): UnlockOutcome | null {
  const hit = supersededCandidates(v).some(({ state, epochId }) => v.opens(state, epochId) !== null);
  return hit ? superseded(v) : null;
}

/** Unlock policy of 4.8: never accept a password that only matches an ancestor epoch. */
export function decideUnlock(input: UnlockInput): UnlockOutcome {
  const v = new UnlockView(input);
  return acceptWCurrent(v) ?? acceptSCurrent(v) ?? acceptMetaKey(v) ?? rejectSuperseded(v) ?? WRONG_PASSWORD;
}
