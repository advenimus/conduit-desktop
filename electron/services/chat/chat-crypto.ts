/**
 * Cloud encryption layer for chat sync.
 *
 * Encrypts conversation blobs using AES-256-GCM with a key derived
 * from the master password via PBKDF2-SHA256.
 *
 * Blob format: [version(1 byte=0x01) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 *
 * This uses a SEPARATE domain context from both the vault cloud encryption
 * (conduit-cloud-v1) and the local chat encryption (conduit-chat-v1), ensuring
 * all three keys are cryptographically independent.
 */

import crypto from 'node:crypto';

/** Format version byte */
const VERSION = 0x01;

/** PBKDF2 iteration count (matches vault crypto) */
const PBKDF2_ITERATIONS = 600_000;

/** Derived key length for AES-256 (bytes) */
const KEY_LEN = 32;

/** Salt length (bytes) */
const SALT_LEN = 32;

/** AES-GCM nonce length (bytes) */
const NONCE_LEN = 12;

/** AES-GCM auth tag length (bytes) */
const TAG_LEN = 16;

/** Domain-separation context for chat cloud encryption. */
const CHAT_CLOUD_KDF_CONTEXT = Buffer.from('conduit-chat-cloud-v1');

/** Minimum blob size: version + salt + nonce + tag (no ciphertext) */
const MIN_BLOB_SIZE = 1 + SALT_LEN + NONCE_LEN + TAG_LEN;

/**
 * Encrypt a chat conversation blob for cloud upload.
 *
 * @param data - JSON string of the conversation blob
 * @param masterPassword - The user's master password
 * @returns Base64-encoded blob: [version(1) | salt(32) | nonce(12) | ciphertext | auth_tag(16)]
 */
export function encryptForCloudChat(data: string, masterPassword: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const domainSalt = Buffer.concat([salt, CHAT_CLOUD_KDF_CONTEXT]);
  const key = crypto.pbkdf2Sync(masterPassword, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const blob = Buffer.concat([
      Buffer.from([VERSION]),
      salt,
      nonce,
      ciphertext,
      tag,
    ]);

    return blob.toString('base64');
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt a chat conversation blob from cloud download.
 *
 * @param base64Blob - Base64-encoded encrypted blob
 * @param masterPassword - The user's master password
 * @returns Decrypted JSON string
 * @throws Error if blob is malformed or password is wrong
 */
export function decryptFromCloudChat(base64Blob: string, masterPassword: string): string {
  const blob = Buffer.from(base64Blob, 'base64');

  if (blob.length < MIN_BLOB_SIZE) {
    throw new Error('Chat cloud blob too short');
  }

  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`Unsupported chat cloud blob version: ${version}`);
  }

  let offset = 1;
  const salt = blob.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const nonce = blob.subarray(offset, offset + NONCE_LEN);
  offset += NONCE_LEN;

  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(offset, blob.length - TAG_LEN);

  const domainSalt = Buffer.concat([salt, CHAT_CLOUD_KDF_CONTEXT]);
  const key = crypto.pbkdf2Sync(masterPassword, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
    } catch {
      throw new Error('Invalid master password. Chat cloud data could not be decrypted.');
    }
  } finally {
    key.fill(0);
  }
}
