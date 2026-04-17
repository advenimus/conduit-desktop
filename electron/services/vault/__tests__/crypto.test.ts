import { describe, it, expect } from 'vitest';
import { deriveKey, generateSalt, encrypt, decrypt } from '../crypto.js';

describe('crypto', () => {
  describe('deriveKey', () => {
    it('produces consistent output for same password and salt', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password123', salt);
      const key2 = deriveKey('password123', salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it('produces different output for different passwords', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password1', salt);
      const key2 = deriveKey('password2', salt);
      expect(key1.equals(key2)).toBe(false);
    });

    it('produces different output for different salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const key1 = deriveKey('password', salt1);
      const key2 = deriveKey('password', salt2);
      expect(key1.equals(key2)).toBe(false);
    });

    it('produces a 32-byte key', () => {
      const salt = generateSalt();
      const key = deriveKey('test', salt);
      expect(key.length).toBe(32);
    });
  });

  describe('generateSalt', () => {
    it('produces a 32-byte salt', () => {
      const salt = generateSalt();
      expect(salt.length).toBe(32);
    });

    it('produces unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1.equals(salt2)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('roundtrips plaintext correctly', () => {
      const salt = generateSalt();
      const key = deriveKey('test_password', salt);
      const plaintext = Buffer.from('Hello, World!');

      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);

      expect(decrypted.toString('utf-8')).toBe('Hello, World!');
    });

    it('fails with wrong key', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password1', salt);
      const key2 = deriveKey('password2', salt);

      const ciphertext = encrypt(Buffer.from('secret'), key1);
      expect(() => decrypt(ciphertext, key2)).toThrow();
    });

    it('handles empty plaintext', () => {
      const key = deriveKey('test', generateSalt());
      const ciphertext = encrypt(Buffer.alloc(0), key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted.length).toBe(0);
    });

    it('handles large plaintext', () => {
      const key = deriveKey('test', generateSalt());
      const plaintext = Buffer.alloc(100_000, 'A');
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces different ciphertext each time (random nonce)', () => {
      const key = deriveKey('test', generateSalt());
      const plaintext = Buffer.from('same input');
      const ct1 = encrypt(plaintext, key);
      const ct2 = encrypt(plaintext, key);
      expect(ct1.equals(ct2)).toBe(false);
    });

    it('rejects truncated ciphertext', () => {
      expect(() => decrypt(Buffer.alloc(10), deriveKey('x', generateSalt()))).toThrow(
        'Ciphertext too short'
      );
    });
  });
});
