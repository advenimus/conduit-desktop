// @vitest-environment node
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_BACKUP_DAMAGED_MESSAGE,
  CLOUD_BACKUP_TOO_LARGE_MESSAGE,
  CLOUD_BLOB_OVERHEAD,
  CLOUD_BLOB_V1,
  CLOUD_BLOB_V2_DEFLATE,
  MAX_CLOUD_BLOB_BYTES,
  decryptFromCloud,
  encryptForCloud,
  isCloudVaultBlob,
  packVaultForCloud,
} from '../cloud-crypto.js';

const PASSWORD = 'correct horse battery staple';

/** Compressible like a real vault: repeated rows with a little noise. */
function vaultLike(bytes: number): Buffer {
  const row = Buffer.from('INSERT INTO entries VALUES (host.example.com, admin, ssh, 22);');
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += row.length) row.copy(out, i);
  crypto.randomBytes(64).copy(out, 0);
  return out;
}

describe('cloud blob 0x01', () => {
  it('stays 0x01 while it fits the bucket and round-trips', () => {
    const raw = vaultLike(64 * 1024);
    const blob = packVaultForCloud(raw, PASSWORD);
    expect(blob[0]).toBe(CLOUD_BLOB_V1);
    expect(blob.length).toBe(raw.length + CLOUD_BLOB_OVERHEAD);
    expect(decryptFromCloud(blob, PASSWORD).equals(raw)).toBe(true);
  });

  it('keeps the old encryptForCloud format', () => {
    const raw = Buffer.from('SQLite format 3\0');
    const blob = encryptForCloud(raw, PASSWORD);
    expect(blob[0]).toBe(CLOUD_BLOB_V1);
    expect(isCloudVaultBlob(blob)).toBe(true);
    expect(decryptFromCloud(blob, PASSWORD).equals(raw)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const blob = encryptForCloud(Buffer.from('vault'), PASSWORD);
    expect(() => decryptFromCloud(blob, 'wrong')).toThrow(/Invalid master password/);
  });
});

describe('cloud blob 0x02 (spec 3.7)', () => {
  it('deflates a vault that would not fit as 0x01, and restores it', () => {
    const raw = vaultLike(MAX_CLOUD_BLOB_BYTES - CLOUD_BLOB_OVERHEAD + 1);
    const blob = packVaultForCloud(raw, PASSWORD);
    expect(blob[0]).toBe(CLOUD_BLOB_V2_DEFLATE);
    expect(blob.length).toBeLessThan(raw.length);
    expect(isCloudVaultBlob(blob)).toBe(true);
    expect(decryptFromCloud(blob, PASSWORD).equals(raw)).toBe(true);
  });

  it('refuses a vault too large even when compressed', () => {
    const raw = crypto.randomBytes(MAX_CLOUD_BLOB_BYTES + 1024);
    expect(() => packVaultForCloud(raw, PASSWORD)).toThrow(CLOUD_BACKUP_TOO_LARGE_MESSAGE);
  });

  it('reports a damaged compressed payload', () => {
    const notDeflate = Buffer.from('this is not raw deflate data at all, just text');
    const blob = encryptForCloud(notDeflate, PASSWORD);
    blob[0] = CLOUD_BLOB_V2_DEFLATE;
    expect(() => decryptFromCloud(blob, PASSWORD)).toThrow(CLOUD_BACKUP_DAMAGED_MESSAGE);
  });

  it('encrypts raw DEFLATE (RFC 1951, no zlib header) inside the usual envelope', () => {
    const raw = vaultLike(MAX_CLOUD_BLOB_BYTES);
    const blob = packVaultForCloud(raw, PASSWORD);
    const salt = blob.subarray(1, 33);
    const nonce = blob.subarray(33, 45);
    const key = crypto.pbkdf2Sync(PASSWORD, Buffer.concat([salt, Buffer.from('conduit-cloud-v1')]), 600_000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const plain = Buffer.concat([decipher.update(blob.subarray(45, blob.length - 16)), decipher.final()]);
    expect(() => zlib.inflateSync(plain)).toThrow();
    expect(zlib.inflateRawSync(plain).equals(raw)).toBe(true);
  });

  it('rejects unknown versions', () => {
    const blob = encryptForCloud(Buffer.from('vault'), PASSWORD);
    blob[0] = 0x03;
    expect(isCloudVaultBlob(blob)).toBe(false);
    expect(() => decryptFromCloud(blob, PASSWORD)).toThrow(/Unsupported cloud vault version/);
  });
});
