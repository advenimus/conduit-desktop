/**
 * AES-256-GCM primitives of key epochs (spec 4.8): secrets in the vault's field format
 * (nonce12 || ct || tag16, the bytes vault/crypto.ts reads and writes), verification tokens,
 * key wraps with AAD, the stale-key read order and "Enter old password".
 * Import through key-epoch.ts.
 */

import crypto from 'node:crypto';
import { decrypt } from '../vault/crypto.js';
import { UNIT_SEP, epochIdOf } from './hashing.js';
import type { EpochKeys, KeyRing, WrapRecord } from './types.js';

/** Plaintext of vault_meta.verification (vault.ts initialize). */
export const VERIFICATION_PLAINTEXT = 'conduit-vault-ok';
export const WRAP_NONCE_LEN = 12;
export const WRAP_TAG_LEN = 16;
export const EPOCH_KEY_LEN = 32;

const CIPHER = 'aes-256-gcm';
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/;

type RandomBytes = (n: number) => Buffer;

function requireKey(key: Buffer): void {
  if (key.length !== EPOCH_KEY_LEN) {
    throw new Error(`key-epoch: expected a ${EPOCH_KEY_LEN}-byte key, got ${key.length}`);
  }
}

function takeNonce(randomBytes: RandomBytes): Buffer {
  const nonce = randomBytes(WRAP_NONCE_LEN);
  if (nonce.length !== WRAP_NONCE_LEN) {
    throw new Error(`key-epoch: randomBytes returned ${nonce.length} bytes, expected ${WRAP_NONCE_LEN}`);
  }
  return nonce;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer | null): Buffer {
  const cipher = crypto.createCipheriv(CIPHER, key, nonce);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** GCM open with AAD. A failed authentication is an expected outcome here, reported as null. */
function openWithAad(key: Buffer, blob: Buffer, aad: Buffer): Buffer | null {
  if (blob.length < WRAP_NONCE_LEN + WRAP_TAG_LEN) return null;
  const nonce = blob.subarray(0, WRAP_NONCE_LEN);
  const tag = blob.subarray(blob.length - WRAP_TAG_LEN);
  const ct = blob.subarray(WRAP_NONCE_LEN, blob.length - WRAP_TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

// ---------- Secrets and verification tokens ----------

/** Encrypts raw plaintext bytes in the vault's field format under `kEpoch`. */
export function sealSecretBytes(plaintext: Buffer, kEpoch: Buffer, randomBytes: RandomBytes): Buffer {
  requireKey(kEpoch);
  return seal(kEpoch, takeNonce(randomBytes), plaintext, null);
}

/** Encrypts plaintext under `keys.kEpoch` in the vault's format (nonce12 || ct || tag16). */
export function encryptSecret(plaintext: string, keys: EpochKeys, randomBytes: RandomBytes): Buffer {
  return sealSecretBytes(Buffer.from(plaintext, 'utf8'), keys.kEpoch, randomBytes);
}

/** Decrypts a vault-format ciphertext; null when `kEpoch` does not open it. */
export function openSecret(ciphertext: Uint8Array, kEpoch: Buffer): Buffer | null {
  requireKey(kEpoch);
  try {
    return decrypt(asBuffer(ciphertext), kEpoch);
  } catch {
    return null;
  }
}

/** true when `kEpoch` decrypts the base64 verification token to VERIFICATION_PLAINTEXT. */
export function verifyKey(kEpoch: Buffer, verificationB64: string): boolean {
  const opened = openSecret(Buffer.from(verificationB64, 'base64'), kEpoch);
  return opened !== null && opened.toString('utf8') === VERIFICATION_PLAINTEXT;
}

/** A fresh vault_meta.verification token (base64) for an epoch key. */
export function makeVerificationToken(keys: EpochKeys, randomBytes: RandomBytes): string {
  return encryptSecret(VERIFICATION_PLAINTEXT, keys, randomBytes).toString('base64');
}

// ---------- Wraps ----------

function wrapAad(epochId: string, targetEpoch: string): Buffer {
  return Buffer.concat([Buffer.from(epochId, 'utf8'), Buffer.from([UNIT_SEP]), Buffer.from(targetEpoch, 'utf8')]);
}

/** (E, T, AES-256-GCM(K_E, K_T)) with AAD = UTF-8(E) || 0x1f || UTF-8(T). */
export function createWrap(wrapper: EpochKeys, target: EpochKeys, randomBytes: RandomBytes): WrapRecord {
  if (wrapper.epochId === target.epochId) throw new Error('key-epoch: an epoch cannot wrap itself');
  requireKey(wrapper.kEpoch);
  requireKey(target.kEpoch);
  const blob = seal(wrapper.kEpoch, takeNonce(randomBytes), target.kEpoch, wrapAad(wrapper.epochId, target.epochId));
  return { epochId: wrapper.epochId, targetEpoch: target.epochId, wrap: blob.toString('hex') };
}

/**
 * The target key if the wrap authenticates under `wrapperKey` (which must be the key of
 * wrap.epochId) with the wrap's AAD AND epochIdOf(result) == wrap.targetEpoch; else null.
 * Invalid wraps are ignored by callers, never deleted (spec 4.8, red team #34).
 */
export function unwrapValidated(wrap: WrapRecord, wrapperKey: Buffer): Buffer | null {
  requireKey(wrapperKey);
  if (!HEX_BYTES.test(wrap.wrap)) return null;
  if (epochIdOf(wrapperKey) !== wrap.epochId) return null;
  const key = openWithAad(wrapperKey, Buffer.from(wrap.wrap, 'hex'), wrapAad(wrap.epochId, wrap.targetEpoch));
  if (key === null || key.length !== EPOCH_KEY_LEN) return null;
  return epochIdOf(key) === wrap.targetEpoch ? key : null;
}

// ---------- Stale-key reads ----------

export interface OpenedSecret {
  readonly plaintext: Buffer;
  readonly keys: EpochKeys;
}

/** First key of `candidates` (in order) that opens the ciphertext. */
export function openWithAny(ciphertext: Uint8Array, candidates: readonly EpochKeys[]): OpenedSecret | null {
  for (const keys of candidates) {
    const plaintext = openSecret(ciphertext, keys.kEpoch);
    if (plaintext !== null) return { plaintext, keys };
  }
  return null;
}

/** ring.current first, then every other ring key in ring order. */
export function ringOrder(ring: KeyRing): EpochKeys[] {
  const out = [ring.current];
  for (const keys of ring.byEpoch.values()) {
    if (keys.epochId !== ring.current.epochId) out.push(keys);
  }
  return out;
}

export type SecretRead =
  | { readonly kind: 'current'; readonly plaintext: string }
  | { readonly kind: 'older'; readonly plaintext: string; readonly epochId: string }
  | { readonly kind: 'undecryptable' };

/** Stale-key rule (4.8): try the current key, then every ring key. */
export function readSecret(ciphertext: Uint8Array, ring: KeyRing): SecretRead {
  const opened = openWithAny(ciphertext, ringOrder(ring));
  if (opened === null) return { kind: 'undecryptable' };
  const plaintext = opened.plaintext.toString('utf8');
  if (opened.keys.epochId === ring.current.epochId) return { kind: 'current', plaintext };
  return { kind: 'older', plaintext, epochId: opened.keys.epochId };
}

/** "Enter old password" (4.8): trial-decrypt one ciphertext with PBKDF2(password, s) for each retained salt. */
export function tryOldPassword(
  ciphertext: Uint8Array,
  retainedSalts: readonly string[],
  deriveFromSalt: (saltB64: string) => Buffer,
): { readonly plaintext: string; readonly key: Buffer } | null {
  const tried = new Set<string>();
  for (const salt of retainedSalts) {
    if (salt.length === 0 || tried.has(salt)) continue;
    tried.add(salt);
    const key = deriveFromSalt(salt);
    const plaintext = openSecret(ciphertext, key);
    if (plaintext !== null) return { plaintext: plaintext.toString('utf8'), key };
  }
  return null;
}
