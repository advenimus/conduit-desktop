/**
 * Local backup encryption layer for vault backup.
 *
 * Encrypts the entire vault SQLite file using AES-256-GCM with a key
 * derived from the master password via PBKDF2-SHA256.
 *
 * Blob format: [version(1 byte=0x01) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 *
 * Uses a distinct domain-separation context ('conduit-local-backup-v1') to ensure
 * the derived key differs from both per-field vault encryption and cloud encryption.
 */

import crypto from 'node:crypto';

/** Format version byte */
const VERSION = 0x01;

/** PBKDF2 iteration count (matches crypto.ts) */
const PBKDF2_ITERATIONS = 600_000;

/** Derived key length for AES-256 (bytes) */
const KEY_LEN = 32;

/** Salt length (bytes) */
const SALT_LEN = 32;

/** AES-GCM nonce length (bytes) */
const NONCE_LEN = 12;

/** AES-GCM auth tag length (bytes) */
const TAG_LEN = 16;

/** Domain-separation context to prevent key reuse with per-field vault and cloud encryption. */
const LOCAL_BACKUP_KDF_CONTEXT = Buffer.from('conduit-local-backup-v1');

/** Minimum blob size: version + salt + nonce + tag (no ciphertext) */
const MIN_BLOB_SIZE = 1 + SALT_LEN + NONCE_LEN + TAG_LEN;

/**
 * Encrypt a raw file buffer for local backup storage.
 *
 * Generates a random salt and nonce, derives a key from the master password
 * via PBKDF2-SHA256, and encrypts the file with AES-256-GCM.
 *
 * @returns Blob: [version(1) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 */
export function encryptForLocalBackup(fileBuffer: Buffer, masterPassword: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  // Domain-separated salt to ensure local backup key differs from other keys
  const domainSalt = Buffer.concat([salt, LOCAL_BACKUP_KDF_CONTEXT]);
  const key = crypto.pbkdf2Sync(masterPassword, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([
      Buffer.from([VERSION]),
      salt,
      nonce,
      ciphertext,
      tag,
    ]);
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt a local backup blob back to the raw file.
 *
 * Extracts the salt and nonce from the header, derives the key from the
 * master password, and decrypts with AES-256-GCM.
 *
 * @throws Error if the blob is malformed, the version is unsupported,
 *         or the master password is incorrect (auth tag mismatch).
 */
export function decryptFromLocalBackup(blob: Buffer, masterPassword: string): Buffer {
  if (blob.length < MIN_BLOB_SIZE) {
    throw new Error('Local backup blob too short');
  }

  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`Unsupported local backup version: ${version}`);
  }

  let offset = 1;
  const salt = blob.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const nonce = blob.subarray(offset, offset + NONCE_LEN);
  offset += NONCE_LEN;

  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(offset, blob.length - TAG_LEN);

  // Domain-separated salt (must match encrypt)
  const domainSalt = Buffer.concat([salt, LOCAL_BACKUP_KDF_CONTEXT]);
  const key = crypto.pbkdf2Sync(masterPassword, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Invalid master password. The local backup could not be decrypted.');
    }
  } finally {
    key.fill(0);
  }
}

/**
 * Check if a buffer looks like a valid local backup blob.
 *
 * Validates the version byte and minimum size. Does NOT verify the encryption —
 * this is a cheap check for format detection.
 */
export function isLocalBackupBlob(blob: Buffer): boolean {
  return blob.length >= MIN_BLOB_SIZE && blob[0] === VERSION;
}
