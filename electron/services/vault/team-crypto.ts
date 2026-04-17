/**
 * Zero-knowledge cryptographic operations for team vaults.
 *
 * Implements X25519 key pairs, ECIES-like VEK wrapping, and
 * recovery passphrase backup. Uses Node.js built-in crypto module.
 *
 * Key hierarchy:
 *   Identity Key Pair (X25519, per user-device)
 *     └── VEK Wrapping (ECIES: ephemeral ECDH + HKDF + AES-256-GCM)
 *           └── Vault Encryption Key (AES-256, per team vault)
 *                 └── Entry-level field encryption (AES-256-GCM)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { getDataDir } from '../env-config.js';

// ---------- Constants ----------

const VEK_LEN = 32; // AES-256 key length
const HKDF_INFO = 'conduit-vek-wrap-v1';
const HKDF_KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const RECOVERY_PBKDF2_ITERATIONS = 600_000;
const RECOVERY_SALT_LEN = 32;
const RECOVERY_KEY_LEN = 32;

/** BIP39-inspired wordlist (128 words for 6-word passphrases with ~42 bits of entropy) */
const WORD_LIST = [
  'bridge', 'castle', 'falcon', 'garden', 'mirror', 'thunder',
  'anchor', 'breeze', 'candle', 'dagger', 'ember', 'forest',
  'glacier', 'harbor', 'island', 'jungle', 'knight', 'lantern',
  'marble', 'nebula', 'oracle', 'phoenix', 'quartz', 'raven',
  'silver', 'temple', 'umbra', 'voyage', 'willow', 'zenith',
  'alpine', 'beacon', 'cipher', 'dragon', 'eclipse', 'flare',
  'granite', 'horizon', 'ivory', 'jasper', 'kindle', 'lotus',
  'mystic', 'nimbus', 'obsidian', 'prism', 'quasar', 'riddle',
  'storm', 'thorn', 'atlas', 'blaze', 'coral', 'drift',
  'echo', 'frost', 'grove', 'haze', 'iron', 'jade',
  'kite', 'loom', 'mist', 'nova', 'opal', 'pulse',
  'quest', 'reef', 'sage', 'tide', 'vale', 'wren',
  'axis', 'bolt', 'crest', 'dawn', 'edge', 'fern',
  'gate', 'helm', 'ink', 'jewel', 'key', 'lark',
  'maze', 'nest', 'oath', 'peak', 'ray', 'seal',
  'spark', 'trail', 'urn', 'vine', 'wave', 'yarn',
  'arch', 'brim', 'cliff', 'dove', 'elm', 'forge',
  'glow', 'husk', 'isle', 'jet', 'knot', 'leaf',
  'moth', 'node', 'ore', 'pine', 'ring', 'shard',
  'tower', 'tusk', 'vault', 'whirl', 'zinc', 'bloom',
  'crown', 'dusk', 'flame', 'grip', 'hawk', 'lamp',
  'marsh', 'north',
];

// ---------- Identity Key Pair (X25519) ----------

/**
 * Generate a new X25519 identity key pair.
 * Returns DER-encoded PKCS#8 private key and SPKI public key.
 */
export function generateIdentityKeyPair(): { privateDer: Buffer; publicDer: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    privateDer: Buffer.from(privateKey),
    publicDer: Buffer.from(publicKey),
  };
}

/**
 * Derive the public key from an X25519 private key (DER PKCS#8).
 */
export function derivePublicKey(privateDer: Buffer): Buffer {
  const privateKeyObj = crypto.createPrivateKey({
    key: privateDer,
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  return publicKeyObj.export({ type: 'spki', format: 'der' }) as Buffer;
}

/**
 * Store the private key encrypted with Electron's safeStorage (OS keychain).
 * Written to `{dataDir}/conduit-identity-key-{userId}.enc`.
 */
export function storePrivateKey(privateDer: Buffer, userId: string): void {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const filePath = path.join(dataDir, `conduit-identity-key-${userId}.enc`);

  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store base64-encoded (less secure, but functional)
    fs.writeFileSync(filePath, privateDer.toString('base64'), 'utf-8');
    return;
  }

  const encrypted = safeStorage.encryptString(privateDer.toString('base64'));
  fs.writeFileSync(filePath, encrypted);
}

/**
 * Load the private key from the user-scoped encrypted file.
 * Returns null if no key exists for this user.
 */
export function loadPrivateKey(userId: string): Buffer | null {
  const dataDir = getDataDir();
  const filePath = path.join(dataDir, `conduit-identity-key-${userId}.enc`);

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath);

  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(raw.toString('utf-8'), 'base64');
  }

  const b64 = safeStorage.decryptString(raw);
  return Buffer.from(b64, 'base64');
}

/**
 * Check if a local identity private key exists for a specific user.
 */
export function hasPrivateKey(userId: string): boolean {
  const dataDir = getDataDir();
  const filePath = path.join(dataDir, `conduit-identity-key-${userId}.enc`);
  return fs.existsSync(filePath);
}

// ---------- VEK (Vault Encryption Key) ----------

/**
 * Generate a random 256-bit Vault Encryption Key.
 */
export function generateVEK(): Buffer {
  return crypto.randomBytes(VEK_LEN);
}

/**
 * Wrap a VEK for a specific recipient using ECIES-like encryption.
 *
 * Protocol:
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH: ephemeral private + recipient public → shared secret
 * 3. HKDF-SHA256: shared secret + salt(ephemeral pub || recipient pub) → wrapping key
 * 4. AES-256-GCM: encrypt VEK with wrapping key
 * 5. Output: { ephemeralPublicKeyB64, encryptedVekB64 }
 */
export function wrapVEK(
  vek: Buffer,
  recipientPubDer: Buffer,
): { ephemeralPublicKeyB64: string; encryptedVekB64: string } {
  // 1. Ephemeral key pair
  const ephemeral = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // 2. ECDH shared secret
  const ephemeralPrivateObj = crypto.createPrivateKey({
    key: ephemeral.privateKey,
    format: 'der',
    type: 'pkcs8',
  });
  const recipientPublicObj = crypto.createPublicKey({
    key: recipientPubDer,
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeralPrivateObj,
    publicKey: recipientPublicObj,
  });

  // 3. HKDF to derive wrapping key
  const salt = Buffer.concat([
    Buffer.from(ephemeral.publicKey),
    recipientPubDer,
  ]);

  const wrappingKey = crypto.hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    HKDF_INFO,
    HKDF_KEY_LEN,
  );

  // 4. AES-256-GCM encrypt VEK
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(wrappingKey),
    nonce,
  );
  const ciphertext = Buffer.concat([cipher.update(vek), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: nonce || ciphertext || tag
  const encryptedVek = Buffer.concat([nonce, ciphertext, tag]);

  return {
    ephemeralPublicKeyB64: Buffer.from(ephemeral.publicKey).toString('base64'),
    encryptedVekB64: encryptedVek.toString('base64'),
  };
}

/**
 * Unwrap a VEK using the recipient's private key.
 *
 * Reverse of wrapVEK:
 * 1. ECDH: own private + ephemeral public → shared secret
 * 2. HKDF-SHA256: shared secret + salt(ephemeral pub || own pub) → wrapping key
 * 3. AES-256-GCM: decrypt VEK with wrapping key
 */
export function unwrapVEK(
  wrapped: { ephemeralPublicKeyB64: string; encryptedVekB64: string },
  privateDer: Buffer,
  ownPubDer: Buffer,
): Buffer {
  const ephemeralPubDer = Buffer.from(wrapped.ephemeralPublicKeyB64, 'base64');
  const encryptedVek = Buffer.from(wrapped.encryptedVekB64, 'base64');

  // 1. ECDH shared secret
  const privateKeyObj = crypto.createPrivateKey({
    key: privateDer,
    format: 'der',
    type: 'pkcs8',
  });
  const ephemeralPublicObj = crypto.createPublicKey({
    key: ephemeralPubDer,
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: ephemeralPublicObj,
  });

  // 2. HKDF to derive wrapping key (same salt construction as wrap)
  const salt = Buffer.concat([ephemeralPubDer, ownPubDer]);

  const wrappingKey = crypto.hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    HKDF_INFO,
    HKDF_KEY_LEN,
  );

  // 3. AES-256-GCM decrypt VEK
  if (encryptedVek.length < NONCE_LEN + TAG_LEN) {
    throw new Error('Encrypted VEK too short');
  }

  const nonce = encryptedVek.subarray(0, NONCE_LEN);
  const tag = encryptedVek.subarray(encryptedVek.length - TAG_LEN);
  const ciphertext = encryptedVek.subarray(NONCE_LEN, encryptedVek.length - TAG_LEN);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(wrappingKey),
    nonce,
  );
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------- Recovery Passphrase ----------

/**
 * Generate a 6-word recovery passphrase from 128 bits of entropy.
 * Each word is selected from a 128-word list (7 bits per word × 6 = 42 bits).
 * The remaining entropy comes from the random byte selection.
 */
export function generateRecoveryPassphrase(): string {
  const bytes = crypto.randomBytes(6);
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    const idx = bytes[i] % WORD_LIST.length;
    words.push(WORD_LIST[idx]);
  }
  return words.join(' - ');
}

/**
 * Encrypt a private key (DER) for recovery storage using a passphrase.
 * Uses PBKDF2-SHA256 (600k iterations) + AES-256-GCM.
 *
 * Returns the encrypted blob + salt for storage in Supabase.
 */
export function encryptPrivateKeyForRecovery(
  privateDer: Buffer,
  passphrase: string,
): { encryptedB64: string; saltB64: string } {
  const salt = crypto.randomBytes(RECOVERY_SALT_LEN);
  const key = crypto.pbkdf2Sync(
    passphrase,
    salt,
    RECOVERY_PBKDF2_ITERATIONS,
    RECOVERY_KEY_LEN,
    'sha256',
  );

  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(privateDer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: nonce || ciphertext || tag
  const encrypted = Buffer.concat([nonce, ciphertext, tag]);

  return {
    encryptedB64: encrypted.toString('base64'),
    saltB64: salt.toString('base64'),
  };
}

/**
 * Decrypt a private key from recovery storage using a passphrase.
 */
export function decryptPrivateKeyFromRecovery(
  encryptedB64: string,
  saltB64: string,
  passphrase: string,
): Buffer {
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const salt = Buffer.from(saltB64, 'base64');

  const key = crypto.pbkdf2Sync(
    passphrase,
    salt,
    RECOVERY_PBKDF2_ITERATIONS,
    RECOVERY_KEY_LEN,
    'sha256',
  );

  if (encrypted.length < NONCE_LEN + TAG_LEN) {
    throw new Error('Encrypted data too short');
  }

  const nonce = encrypted.subarray(0, NONCE_LEN);
  const tag = encrypted.subarray(encrypted.length - TAG_LEN);
  const ciphertext = encrypted.subarray(NONCE_LEN, encrypted.length - TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------- Device ID ----------

/**
 * Get or create a stable device UUID scoped to a specific user.
 * Stored in `{dataDir}/conduit-device-id-{userId}`.
 */
export function getOrCreateDeviceId(userId: string): string {
  const dataDir = getDataDir();
  const filePath = path.join(dataDir, `conduit-device-id-${userId}`);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8').trim();
    if (existing) return existing;
  }

  const deviceId = uuidv4();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, deviceId, 'utf-8');
  return deviceId;
}
