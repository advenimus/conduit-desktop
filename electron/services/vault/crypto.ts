/**
 * Cryptographic operations for the credential vault.
 *
 * Port of crates/conduit-vault/src/crypto.rs
 * Uses Node.js built-in crypto module for AES-256-GCM and PBKDF2.
 */

import crypto from 'node:crypto';

/** PBKDF2 iteration count (OWASP 2023 recommendation) */
const PBKDF2_ITERATIONS = 600_000;

/** Derived key length for AES-256 (bytes) */
const KEY_LEN = 32;

/** Salt length (bytes) */
const SALT_LEN = 32;

/** AES-GCM nonce length (bytes) */
const NONCE_LEN = 12;

/** AES-GCM auth tag length (bytes) */
const TAG_LEN = 16;

/**
 * Derive an encryption key from a password and salt using PBKDF2-SHA256.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

/**
 * Generate a random 32-byte salt.
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * Encrypt data using AES-256-GCM.
 *
 * Returns a single buffer: [nonce (12 bytes) | ciphertext | auth tag (16 bytes)]
 * This matches the Rust implementation which prepends the nonce.
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);

  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: nonce || ciphertext || tag
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Decrypt data that was encrypted with `encrypt()`.
 *
 * Expects input format: [nonce (12 bytes) | ciphertext | auth tag (16 bytes)]
 */
export function decrypt(encrypted: Buffer, key: Buffer): Buffer {
  if (encrypted.length < NONCE_LEN + TAG_LEN) {
    throw new Error('Ciphertext too short');
  }

  const nonce = encrypted.subarray(0, NONCE_LEN);
  const tag = encrypted.subarray(encrypted.length - TAG_LEN);
  const ciphertext = encrypted.subarray(NONCE_LEN, encrypted.length - TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
