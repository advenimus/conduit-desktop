/**
 * Moving a whole state between key epochs (spec 4.8): re-encrypt every secret sibling a ring
 * key opens under the target epoch and recompute its keyed vhash (identities, pids, lt and
 * prev never change; no new dots), and redaction of superseded epochs. Import through key-epoch.ts.
 */

import crypto from 'node:crypto';
import { CONTENT_TBLS, asBlob, fixedRegisters } from './catalog.js';
import { vhashOfSecret, vhashUndecryptable } from './hashing.js';
import { openWithAny, sealSecretBytes } from './key-epoch-crypto.js';
import { buildKeyRing } from './key-epoch-ring.js';
import { isRedacted, isUndecryptable, isValueUnknown } from './sibling.js';
import { StateBuilder, currentEpochId, isImplicitEquivalent } from './state-view.js';
import { SIB_UNDECRYPTABLE } from './types.js';
import type { EpochKeys, KeyRing, RegKey, RegisterState, Sibling, SyncState, Tbl } from './types.js';

/** Secret register names per content table (catalog order). */
const SECRET_REGS: ReadonlyMap<Tbl, readonly string[]> = new Map(
  CONTENT_TBLS.map((tbl) => [tbl as Tbl, fixedRegisters(tbl).filter((d) => d.secret).map((d) => d.reg)]),
);

export interface ReencryptResult {
  readonly state: SyncState;
  /** Siblings no ring key could decrypt (left as, or turned into, undecryptable siblings). */
  readonly undecryptable: number;
}

export interface ReencryptOptions {
  /** Nonce source for new ciphertexts (default node:crypto). */
  readonly randomBytes?: (n: number) => Buffer;
  /** false: leave siblings no key opens untouched instead of flagging them undecryptable. */
  readonly markUnreadable?: boolean;
  /**
   * Keys of the epoch the state's vhashes are keyed under. When given, a sibling is re-keyed
   * only if its value still hashes to its stored vhash; others are left untouched because their
   * value was loaded from content a legacy app may have changed.
   */
  readonly verifyWith?: EpochKeys;
}

interface Plan {
  readonly order: readonly EpochKeys[];
  readonly to: EpochKeys;
  readonly randomBytes: (n: number) => Buffer;
  readonly markUnreadable: boolean;
  readonly verifyWith: EpochKeys | null;
}

interface SiblingOutcome {
  readonly sib: Sibling;
  readonly unreadable: boolean;
}

/** Visits every explicit secret register of the state. */
function forEachSecretRegister(state: SyncState, visit: (reg: RegisterState) => void): void {
  for (const row of state.rows.values()) {
    const names = SECRET_REGS.get(row.key.tbl);
    if (!names) continue;
    for (const name of names) {
      const reg = row.regs.get(name);
      if (reg) visit(reg);
    }
  }
}

/** The state's own current key first, then `to`, then the rest of the ring. */
function decryptOrder(state: SyncState, ring: KeyRing, to: EpochKeys): EpochKeys[] {
  const out: EpochKeys[] = [];
  const seen = new Set<string>();
  const push = (keys: EpochKeys | undefined): void => {
    if (keys && !seen.has(keys.epochId)) {
      seen.add(keys.epochId);
      out.push(keys);
    }
  };
  const cur = currentEpochId(state);
  push(cur === null ? undefined : ring.byEpoch.get(cur));
  push(to);
  push(ring.current);
  for (const keys of ring.byEpoch.values()) push(keys);
  return out;
}

function keep(sib: Sibling, unreadable = false): SiblingOutcome {
  return { sib, unreadable };
}

function rekeyNull(key: RegKey, s: Sibling, plan: Plan): SiblingOutcome {
  if (plan.verifyWith && vhashOfSecret(key, null, plan.verifyWith.kSync) !== s.vhash) return keep(s);
  const vhash = vhashOfSecret(key, null, plan.to.kSync);
  const flags = s.flags & ~SIB_UNDECRYPTABLE;
  return vhash === s.vhash && flags === s.flags ? keep(s) : keep({ ...s, vhash, flags });
}

function markUnreadable(s: Sibling, ct: Uint8Array, plan: Plan): SiblingOutcome {
  if (isUndecryptable(s) || !plan.markUnreadable) return keep(s, true);
  return keep({ ...s, flags: s.flags | SIB_UNDECRYPTABLE, vhash: vhashUndecryptable(ct) }, true);
}

function storedHashMatches(key: RegKey, s: Sibling, ct: Uint8Array, plaintext: string, verify: EpochKeys): boolean {
  const expected = isUndecryptable(s) ? vhashUndecryptable(ct) : vhashOfSecret(key, plaintext, verify.kSync);
  return expected === s.vhash;
}

function rekeySibling(key: RegKey, s: Sibling, plan: Plan): SiblingOutcome {
  // No value to re-key; the copy that carries it is re-keyed on the replica that holds it.
  if (isRedacted(s) || isValueUnknown(s)) return keep(s);
  const ct = asBlob(s.value);
  if (ct === null) return rekeyNull(key, s, plan);
  const opened = openWithAny(ct, plan.order);
  if (opened === null) return markUnreadable(s, ct, plan);
  const plaintext = opened.plaintext.toString('utf8');
  if (plan.verifyWith && !storedHashMatches(key, s, ct, plaintext, plan.verifyWith)) return keep(s);
  const vhash = vhashOfSecret(key, plaintext, plan.to.kSync);
  const flags = s.flags & ~SIB_UNDECRYPTABLE;
  const sameKey = opened.keys.epochId === plan.to.epochId;
  if (sameKey && vhash === s.vhash && flags === s.flags) return keep(s);
  const value = sameKey ? s.value : sealSecretBytes(opened.plaintext, plan.to.kEpoch, plan.randomBytes);
  return keep({ ...s, value, vhash, flags });
}

function rekeyRegister(reg: RegisterState, plan: Plan): { readonly reg: RegisterState; readonly unreadable: number } {
  let changed = false;
  let unreadable = 0;
  const sibs = reg.sibs.map((s) => {
    const out = rekeySibling(reg.key, s, plan);
    if (out.unreadable) unreadable++;
    if (out.sib !== s) changed = true;
    return out.sib;
  });
  // Identities are unchanged, so the canonical sibling order holds; `mat` is dropped (materialize recomputes).
  return { reg: changed ? { key: reg.key, sibs, pmem: reg.pmem } : reg, unreadable };
}

/**
 * Re-encrypts every secret sibling value decryptable with any ring key under `to`, and
 * recomputes keyed vhashes with to.kSync. Undecryptable siblings that a ring key now opens
 * become decryptable. pids never change. No new dots. Untouched objects are preserved.
 */
export function reencryptState(state: SyncState, ring: KeyRing, to: EpochKeys, options: ReencryptOptions = {}): ReencryptResult {
  const plan: Plan = {
    order: decryptOrder(state, ring, to),
    to,
    randomBytes: options.randomBytes ?? crypto.randomBytes,
    markUnreadable: options.markUnreadable ?? true,
    verifyWith: options.verifyWith ?? null,
  };
  const b = new StateBuilder(state);
  let undecryptable = 0;
  forEachSecretRegister(state, (reg) => {
    const out = rekeyRegister(reg, plan);
    undecryptable += out.unreadable;
    if (out.reg === reg) return;
    if (isImplicitEquivalent(out.reg)) b.removeRegister(reg.key);
    else b.setRegister(out.reg);
  });
  return { state: b.build(), undecryptable };
}

/** true when any secret sibling of the state is flagged undecryptable. */
export function hasUndecryptable(state: SyncState): boolean {
  let found = false;
  forEachSecretRegister(state, (reg) => {
    if (!found && reg.sibs.some(isUndecryptable)) found = true;
  });
  return found;
}

/** The ring as seen from the state's own current epoch (redaction is relative to it). */
function ringFromStateCurrent(state: SyncState, ring: KeyRing): KeyRing | null {
  const cur = currentEpochId(state);
  if (cur === null) return null;
  if (cur === ring.current.epochId) return ring;
  const keys = ring.byEpoch.get(cur);
  return keys ? buildKeyRing(state, keys, state.lineageId) : null;
}

/**
 * 4.8 redaction: every epoch the state's current epoch reaches through valid wraps (except the
 * current one) loses its verification, and its salt unless undecryptable siblings exist
 * ("Enter old password" needs the salts).
 */
export function redactSuperseded(state: SyncState, ring: KeyRing): SyncState {
  const reach = ringFromStateCurrent(state, ring);
  if (reach === null) return state;
  const keepSalt = hasUndecryptable(state);
  const b = new StateBuilder(state);
  for (const id of reach.byEpoch.keys()) {
    const rec = state.epochs.get(id);
    if (id === reach.current.epochId || rec === undefined) continue;
    const salt = keepSalt ? rec.salt : null;
    if (rec.verification === null && rec.salt === salt) continue;
    b.setEpoch({ ...rec, verification: null, salt });
  }
  return b.build();
}
