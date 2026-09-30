/**
 * Cloud encryption layer for vault backup.
 *
 * Encrypts the entire vault SQLite file using AES-256-GCM with a key
 * derived from the master password via PBKDF2-SHA256.
 *
 * Blob format: [version(1) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 * - 0x01: the ciphertext is the vault file itself.
 * - 0x02: the ciphertext is the vault file compressed with raw DEFLATE (RFC 1951, no zlib
 *   header). Used only when a 0x01 blob would not fit the 10 MiB storage bucket (spec 3.7), so
 *   smaller vaults stay readable by apps that only know 0x01.
 *
 * This is a SECOND encryption layer on top of the per-field encryption
 * already performed by crypto.ts. The SQLite file contains plaintext metadata
 * (hostnames, usernames, folder names); this layer encrypts everything,
 * providing true zero-knowledge cloud storage.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const CLOUD_BLOB_V1 = 0x01;
export const CLOUD_BLOB_V2_DEFLATE = 0x02;
const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([CLOUD_BLOB_V1, CLOUD_BLOB_V2_DEFLATE]);

/** Size limit of the `vaults` storage bucket. */
export const MAX_CLOUD_BLOB_BYTES = 10 * 1024 * 1024;

/** A hostile or damaged 0x02 blob cannot inflate past this. */
export const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

export const CLOUD_BACKUP_TOO_LARGE_MESSAGE = 'This vault is too large for cloud backup, even compressed.';
export const CLOUD_BACKUP_DAMAGED_MESSAGE = 'The cloud backup is damaged and cannot be restored.';
export const CLOUD_BACKUP_WRONG_PASSWORD_MESSAGE = 'Invalid master password. The cloud vault could not be decrypted.';

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

/** Domain-separation context to prevent key reuse with per-field vault encryption. */
const CLOUD_KDF_CONTEXT = Buffer.from('conduit-cloud-v1');

/** Minimum blob size: version + salt + nonce + tag (no ciphertext) */
export const CLOUD_BLOB_OVERHEAD = 1 + SALT_LEN + NONCE_LEN + TAG_LEN;

function deriveCloudKey(masterPassword: string, salt: Buffer): Buffer {
  // Domain-separated salt to ensure cloud key differs from per-field vault key
  const domainSalt = Buffer.concat([salt, CLOUD_KDF_CONTEXT]);
  return crypto.pbkdf2Sync(masterPassword, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

function encryptWithVersion(plain: Buffer, masterPassword: string, version: number): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = deriveCloudKey(masterPassword, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([version]), salt, nonce, ciphertext, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

/**
 * Encrypt a raw file buffer as a 0x01 blob.
 *
 * @returns Blob: [version(1) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 */
export function encryptForCloud(fileBuffer: Buffer, masterPassword: string): Buffer {
  return encryptWithVersion(fileBuffer, masterPassword, CLOUD_BLOB_V1);
}

/** 0x01 when it fits the bucket, else 0x02 (deflated); throws when even 0x02 does not fit. */
export function packVaultForCloud(fileBuffer: Buffer, masterPassword: string): Buffer {
  const fitsPlain = fileBuffer.length + CLOUD_BLOB_OVERHEAD <= MAX_CLOUD_BLOB_BYTES;
  const blob = fitsPlain
    ? encryptWithVersion(fileBuffer, masterPassword, CLOUD_BLOB_V1)
    : encryptWithVersion(zlib.deflateRawSync(fileBuffer), masterPassword, CLOUD_BLOB_V2_DEFLATE);
  if (blob.length > MAX_CLOUD_BLOB_BYTES) throw new Error(CLOUD_BACKUP_TOO_LARGE_MESSAGE);
  return blob;
}

function inflateVault(deflated: Buffer): Buffer {
  try {
    return zlib.inflateRawSync(deflated, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    throw new Error(CLOUD_BACKUP_DAMAGED_MESSAGE);
  }
}

/**
 * Decrypt a cloud vault blob (0x01 or 0x02) back to the raw SQLite file.
 *
 * @throws Error if the blob is malformed, the version is unsupported,
 *         or the master password is incorrect (auth tag mismatch).
 */
export function decryptFromCloud(blob: Buffer, masterPassword: string): Buffer {
  if (blob.length < CLOUD_BLOB_OVERHEAD) {
    throw new Error('Cloud vault blob too short');
  }

  const version = blob[0];
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`Unsupported cloud vault version: ${version}`);
  }

  let offset = 1;
  const salt = blob.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const nonce = blob.subarray(offset, offset + NONCE_LEN);
  offset += NONCE_LEN;

  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(offset, blob.length - TAG_LEN);

  const key = deriveCloudKey(masterPassword, salt);
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    try {
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error(CLOUD_BACKUP_WRONG_PASSWORD_MESSAGE);
    }
  } finally {
    key.fill(0);
  }
  return version === CLOUD_BLOB_V2_DEFLATE ? inflateVault(plain) : plain;
}

/**
 * Check if a buffer looks like a valid cloud vault blob.
 *
 * Validates the version byte and minimum size. Does NOT verify the encryption:
 * this is a cheap check for format detection.
 */
export function isCloudVaultBlob(blob: Buffer): boolean {
  return blob.length >= CLOUD_BLOB_OVERHEAD && SUPPORTED_VERSIONS.has(blob[0]);
}
