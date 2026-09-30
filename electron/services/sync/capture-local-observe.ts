/**
 * Value observation for capture (spec 4.2 step 1, 4.3): hashes a register value as stored in
 * content, opening secrets with the stale-key rule (4.8), and compares it with the value the
 * state expects to see materialized. Shared by capture-local and capture-legacy.
 */

import { canonEqual } from './canonical.js';
import { isDefaultValue } from './catalog.js';
import { vhashOfSecret, vhashOfValue, vhashUndecryptable } from './hashing.js';
import { encryptSecret, readSecret } from './key-epoch.js';
import { isRedacted, isUndecryptable, isValueUnknown, valuesIdentical } from './sibling.js';
import { provisional, type StateBuilder } from './state-view.js';
import {
  SIB_UNDECRYPTABLE,
  type EpochKeys,
  type KeyRing,
  type RegKey,
  type RegisterDef,
  type RegisterState,
  type Sibling,
  type SyncContext,
  type SyncValue,
} from './types.js';

/** Keys a capture hashes and stores secrets under, plus every key that may open stored ciphertext. */
export interface SecretKeys {
  /** Epoch whose K_sync keys secret vhashes and under whose key new sibling values are stored. */
  readonly target: EpochKeys;
  /** Ring whose `current` is `target` (readSecret tries it first, then every other key). */
  readonly ring: KeyRing;
}

/** Local capture works under the state's current epoch (ctx.keys.current). */
export function localSecretKeys(ctx: Pick<SyncContext, 'keys'>): SecretKeys {
  return { target: ctx.keys.current, ring: ctx.keys };
}

/** Legacy capture works under E_abs, falling back to every key of the device's ring. */
export function absorbSecretKeys(absorb: EpochKeys, ring: KeyRing): SecretKeys {
  const byEpoch = new Map(ring.byEpoch);
  byEpoch.set(absorb.epochId, absorb);
  return { target: absorb, ring: { current: absorb, byEpoch } };
}

/** One register value as observed in content. */
export interface Observation {
  readonly vhash: string;
  /** 0, or SIB_UNDECRYPTABLE for a secret no key could open. */
  readonly flags: number;
  /** The value as stored (secrets: the stored ciphertext bytes, or null). */
  readonly value: SyncValue;
  /** Plaintext of a secret opened by a non-target key; it must be re-encrypted before storing. */
  readonly reseal: string | null;
  /**
   * Plaintext of an opened secret (transient, capture only): the stale-revert test re-hashes it
   * under every ring epoch, because a prev_vhash keeps the K_sync it was written under.
   */
  readonly plaintext: string | null;
}

export function observe(key: RegKey, def: RegisterDef, value: SyncValue, keys: SecretKeys): Observation {
  if (!def.secret) return { vhash: vhashOfValue(key, value), flags: 0, value, reseal: null, plaintext: null };
  return observeSecret(key, value, keys);
}

function toBytes(value: SyncValue): Uint8Array | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return value.length === 0 ? null : value;
  const text = String(value);
  return text.length === 0 ? null : Buffer.from(text, 'utf8');
}

/** An opened secret: its keyed vhash, the stored bytes and (when opened by an older key) the reseal plaintext. */
function openedSecret(key: RegKey, bytes: Uint8Array, plaintext: string, older: boolean, kSync: Buffer): Observation {
  const vhash = vhashOfSecret(key, plaintext, kSync);
  return { vhash, flags: 0, value: bytes, reseal: older ? plaintext : null, plaintext };
}

function observeSecret(key: RegKey, value: SyncValue, keys: SecretKeys): Observation {
  const bytes = toBytes(value);
  const kSync = keys.target.kSync;
  if (bytes === null) return { vhash: vhashOfSecret(key, null, kSync), flags: 0, value: null, reseal: null, plaintext: null };
  const read = readSecret(bytes, keys.ring);
  switch (read.kind) {
    case 'current':
      return openedSecret(key, bytes, read.plaintext, false, kSync);
    case 'older':
      return openedSecret(key, bytes, read.plaintext, true, kSync);
    case 'undecryptable':
      return { vhash: vhashUndecryptable(bytes), flags: SIB_UNDECRYPTABLE, value: bytes, reseal: null, plaintext: null };
  }
}

/** The value a new sibling stores: the stored bytes, or a fresh ciphertext under the target key. */
export function sealValue(obs: Observation, keys: SecretKeys, ctx: Pick<SyncContext, 'randomBytes'>): SyncValue {
  if (obs.reseal === null) return obs.value;
  return encryptSecret(obs.reseal, keys.target, ctx.randomBytes);
}

/** An unchanged register whose stored ciphertext opened only with a non-target key. */
export interface StaleKeyValue {
  readonly key: RegKey;
  readonly obs: Observation;
}

/**
 * Stale-key rule (4.8) for values that did not change: the provisional value the loader read
 * from that content is re-encrypted under the target key. A value repair, not a write: no dot.
 * A provisional carried elsewhere (a carrier or another replica's bytes) is left alone.
 */
export function resealStaleValues(
  b: StateBuilder,
  stale: readonly StaleKeyValue[],
  keys: SecretKeys,
  ctx: Pick<SyncContext, 'randomBytes'>,
): number {
  let repaired = 0;
  for (const { key, obs } of stale) {
    const reg = b.register(key);
    const prov = reg ? provisional(key.reg, reg.sibs) : null;
    if (!reg || prov === null || prov.vhash !== obs.vhash || !valuesIdentical(prov.value, obs.value)) continue;
    const fixed: Sibling = { ...prov, value: sealValue(obs, keys, ctx) };
    b.setRegister({ ...reg, sibs: reg.sibs.map((s) => (s === prov ? fixed : s)) });
    repaired++;
  }
  return repaired;
}

/** The raw-value default test used for implicit registers and inserts (no hashing). */
export function isDefaultRaw(def: RegisterDef, value: SyncValue): boolean {
  return def.secret ? toBytes(value) === null : isDefaultValue(def, value);
}

/** Content holds the NOT NULL fallback materialize writes for a null or redacted value. */
function isFallbackForm(def: RegisterDef, value: SyncValue): boolean {
  return !def.secret && def.notNullFallback !== null && canonEqual(def, value, def.notNullFallback);
}

function logicalHash(key: RegKey, def: RegisterDef, value: SyncValue, keys: SecretKeys): string {
  return def.secret ? observeSecret(key, value, keys).vhash : vhashOfValue(key, value);
}

/**
 * True when the observed content value is what materialize would have written for this
 * register: `mat` when set, else the provisional sibling's vhash, else the default (implicit
 * registers, and registers whose siblings are all redacted or undecryptable).
 */
export function matchesExpected(
  key: RegKey,
  def: RegisterDef,
  reg: RegisterState | undefined,
  obs: Observation,
  keys: SecretKeys,
): boolean {
  if (!reg) return isDefaultRaw(def, obs.value);
  if (reg.mat) return obs.vhash === logicalHash(key, def, reg.mat.value, keys);
  const prov = provisional(key.reg, reg.sibs);
  if (!prov) return isDefaultRaw(def, obs.value) || isFallbackForm(def, obs.value);
  if (obs.vhash === prov.vhash) return true;
  return isFallbackForm(def, obs.value) && prov.vhash === vhashOfValue(key, null);
}

/**
 * True when a sibling's in-memory value hashes to its vhash. A head value the loader read
 * from content that a legacy app has since changed fails this test, and
 * so does a sibling flagged SIB_VALUE_UNKNOWN (it carries no value).
 */
export function siblingConsistent(key: RegKey, def: RegisterDef, s: Sibling, keys: SecretKeys): boolean {
  if (isValueUnknown(s)) return false;
  if (isRedacted(s)) return true;
  try {
    if (isUndecryptable(s)) {
      const bytes = toBytes(s.value);
      return bytes !== null && vhashUndecryptable(bytes) === s.vhash;
    }
    return logicalHash(key, def, s.value, keys) === s.vhash;
  } catch {
    // A value canon() rejects cannot be the value its vhash was computed over.
    return false;
  }
}
