import { describe, it, expect } from 'vitest';
import {
  generateIdentityKeyPair,
  derivePublicKey,
  generateVEK,
  wrapVEK,
  unwrapVEK,
  generateRecoveryPassphrase,
  encryptPrivateKeyForRecovery,
  decryptPrivateKeyFromRecovery,
} from '../team-crypto.js';

describe('team-crypto', () => {
  describe('identity key pair', () => {
    it('should generate a valid X25519 key pair', () => {
      const { privateDer, publicDer } = generateIdentityKeyPair();
      expect(privateDer).toBeInstanceOf(Buffer);
      expect(publicDer).toBeInstanceOf(Buffer);
      expect(privateDer.length).toBeGreaterThan(0);
      expect(publicDer.length).toBeGreaterThan(0);
    });

    it('should derive the same public key from a private key', () => {
      const { privateDer, publicDer } = generateIdentityKeyPair();
      const derived = derivePublicKey(privateDer);
      expect(derived).toEqual(publicDer);
    });

    it('should generate different key pairs each time', () => {
      const kp1 = generateIdentityKeyPair();
      const kp2 = generateIdentityKeyPair();
      expect(kp1.privateDer).not.toEqual(kp2.privateDer);
      expect(kp1.publicDer).not.toEqual(kp2.publicDer);
    });
  });

  describe('VEK generation', () => {
    it('should generate a 32-byte VEK', () => {
      const vek = generateVEK();
      expect(vek).toBeInstanceOf(Buffer);
      expect(vek.length).toBe(32);
    });

    it('should generate unique VEKs', () => {
      const vek1 = generateVEK();
      const vek2 = generateVEK();
      expect(vek1).not.toEqual(vek2);
    });
  });

  describe('VEK wrapping (ECIES)', () => {
    it('should wrap and unwrap a VEK round-trip', () => {
      const recipient = generateIdentityKeyPair();
      const vek = generateVEK();

      const wrapped = wrapVEK(vek, recipient.publicDer);
      expect(wrapped.ephemeralPublicKeyB64).toBeTruthy();
      expect(wrapped.encryptedVekB64).toBeTruthy();

      const unwrapped = unwrapVEK(wrapped, recipient.privateDer, recipient.publicDer);
      expect(unwrapped).toEqual(vek);
    });

    it('should fail to unwrap with wrong private key', () => {
      const recipient = generateIdentityKeyPair();
      const wrongKey = generateIdentityKeyPair();
      const vek = generateVEK();

      const wrapped = wrapVEK(vek, recipient.publicDer);

      expect(() => {
        unwrapVEK(wrapped, wrongKey.privateDer, wrongKey.publicDer);
      }).toThrow();
    });

    it('should produce different ciphertexts for the same VEK (ephemeral key)', () => {
      const recipient = generateIdentityKeyPair();
      const vek = generateVEK();

      const wrapped1 = wrapVEK(vek, recipient.publicDer);
      const wrapped2 = wrapVEK(vek, recipient.publicDer);

      // Different ephemeral keys → different ciphertexts
      expect(wrapped1.ephemeralPublicKeyB64).not.toEqual(wrapped2.ephemeralPublicKeyB64);
      expect(wrapped1.encryptedVekB64).not.toEqual(wrapped2.encryptedVekB64);

      // But both decrypt to the same VEK
      const unwrapped1 = unwrapVEK(wrapped1, recipient.privateDer, recipient.publicDer);
      const unwrapped2 = unwrapVEK(wrapped2, recipient.privateDer, recipient.publicDer);
      expect(unwrapped1).toEqual(vek);
      expect(unwrapped2).toEqual(vek);
    });

    it('should wrap VEK for multiple recipients independently', () => {
      const user1 = generateIdentityKeyPair();
      const user2 = generateIdentityKeyPair();
      const vek = generateVEK();

      const wrappedForUser1 = wrapVEK(vek, user1.publicDer);
      const wrappedForUser2 = wrapVEK(vek, user2.publicDer);

      const unwrapped1 = unwrapVEK(wrappedForUser1, user1.privateDer, user1.publicDer);
      const unwrapped2 = unwrapVEK(wrappedForUser2, user2.privateDer, user2.publicDer);

      expect(unwrapped1).toEqual(vek);
      expect(unwrapped2).toEqual(vek);

      // User1 cannot unwrap user2's wrapped VEK
      expect(() => {
        unwrapVEK(wrappedForUser2, user1.privateDer, user1.publicDer);
      }).toThrow();
    });
  });

  describe('recovery passphrase', () => {
    it('should generate a 6-word passphrase', () => {
      const passphrase = generateRecoveryPassphrase();
      const words = passphrase.split(' - ');
      expect(words.length).toBe(6);
      words.forEach((word) => {
        expect(word.length).toBeGreaterThan(0);
      });
    });

    it('should generate different passphrases', () => {
      const p1 = generateRecoveryPassphrase();
      const p2 = generateRecoveryPassphrase();
      // Very unlikely to be the same given random entropy
      expect(p1).not.toEqual(p2);
    });
  });

  describe('private key recovery', () => {
    it('should encrypt and decrypt a private key with passphrase round-trip', () => {
      const { privateDer } = generateIdentityKeyPair();
      const passphrase = 'bridge - castle - falcon - garden - mirror - thunder';

      const { encryptedB64, saltB64 } = encryptPrivateKeyForRecovery(privateDer, passphrase);
      expect(encryptedB64).toBeTruthy();
      expect(saltB64).toBeTruthy();

      const recovered = decryptPrivateKeyFromRecovery(encryptedB64, saltB64, passphrase);
      expect(recovered).toEqual(privateDer);
    });

    it('should fail with wrong passphrase', () => {
      const { privateDer } = generateIdentityKeyPair();
      const passphrase = 'bridge - castle - falcon - garden - mirror - thunder';

      const { encryptedB64, saltB64 } = encryptPrivateKeyForRecovery(privateDer, passphrase);

      expect(() => {
        decryptPrivateKeyFromRecovery(encryptedB64, saltB64, 'wrong - passphrase - here - one - two - three');
      }).toThrow();
    });

    it('should produce different ciphertexts for the same key (unique salt)', () => {
      const { privateDer } = generateIdentityKeyPair();
      const passphrase = 'bridge - castle - falcon - garden - mirror - thunder';

      const result1 = encryptPrivateKeyForRecovery(privateDer, passphrase);
      const result2 = encryptPrivateKeyForRecovery(privateDer, passphrase);

      expect(result1.saltB64).not.toEqual(result2.saltB64);
      expect(result1.encryptedB64).not.toEqual(result2.encryptedB64);
    });
  });

  describe('integration: full key lifecycle', () => {
    it('should generate keys, wrap VEK, unwrap VEK, and verify', () => {
      // Simulate: admin creates team vault, adds member
      const admin = generateIdentityKeyPair();
      const member = generateIdentityKeyPair();

      // Admin generates VEK for the vault
      const vek = generateVEK();

      // Admin wraps VEK for themselves and for the member
      const wrappedForAdmin = wrapVEK(vek, admin.publicDer);
      const wrappedForMember = wrapVEK(vek, member.publicDer);

      // Both can unwrap
      const adminVek = unwrapVEK(wrappedForAdmin, admin.privateDer, admin.publicDer);
      const memberVek = unwrapVEK(wrappedForMember, member.privateDer, member.publicDer);

      expect(adminVek).toEqual(vek);
      expect(memberVek).toEqual(vek);
      expect(adminVek).toEqual(memberVek);
    });

    it('should support recovery after key loss', () => {
      // User generates key pair
      const original = generateIdentityKeyPair();
      const passphrase = generateRecoveryPassphrase();

      // Create recovery backup
      const backup = encryptPrivateKeyForRecovery(original.privateDer, passphrase);

      // Simulate: user loses device, recovers on new device
      const recovered = decryptPrivateKeyFromRecovery(
        backup.encryptedB64,
        backup.saltB64,
        passphrase,
      );

      // Recovered key should derive the same public key
      const recoveredPub = derivePublicKey(recovered);
      expect(recoveredPub).toEqual(original.publicDer);

      // Recovered key should be able to unwrap a VEK
      const vek = generateVEK();
      const wrapped = wrapVEK(vek, original.publicDer);
      const unwrapped = unwrapVEK(wrapped, recovered, recoveredPub);
      expect(unwrapped).toEqual(vek);
    });
  });
});
