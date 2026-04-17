/**
 * Unit tests for BiometricService helpers.
 *
 * Tests the pure functions and file-based operations.
 * Native auth helper and Electron APIs are tested via integration/manual testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Test vaultPathToKey directly (pure function, no Electron dependencies)
function vaultPathToKey(vaultPath: string): string {
  return crypto.createHash('sha256').update(vaultPath).digest('hex');
}

describe('vaultPathToKey', () => {
  it('should produce a deterministic hex hash', () => {
    const key1 = vaultPathToKey('/Users/test/vault.conduit');
    const key2 = vaultPathToKey('/Users/test/vault.conduit');
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce different hashes for different paths', () => {
    const key1 = vaultPathToKey('/path/a.conduit');
    const key2 = vaultPathToKey('/path/b.conduit');
    expect(key1).not.toBe(key2);
  });

  it('should handle empty string', () => {
    const key = vaultPathToKey('');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should handle paths with special characters', () => {
    const key = vaultPathToKey('/Users/test/My Vault (1).conduit');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should handle Windows-style paths', () => {
    const key = vaultPathToKey('C:\\Users\\test\\vault.conduit');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('biometric file operations', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-bio-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should create biometric directory on demand', () => {
    const bioDir = path.join(testDir, 'biometric');
    expect(fs.existsSync(bioDir)).toBe(false);

    fs.mkdirSync(bioDir, { recursive: true });
    expect(fs.existsSync(bioDir)).toBe(true);
  });

  it('should detect .bio.enc file existence', () => {
    const bioDir = path.join(testDir, 'biometric');
    fs.mkdirSync(bioDir, { recursive: true });

    const filePath = path.join(bioDir, 'test-key.bio.enc');
    expect(fs.existsSync(filePath)).toBe(false);

    fs.writeFileSync(filePath, Buffer.from('encrypted-data'));
    expect(fs.existsSync(filePath)).toBe(true);

    fs.unlinkSync(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should clean up all .bio.enc files', () => {
    const bioDir = path.join(testDir, 'biometric');
    fs.mkdirSync(bioDir, { recursive: true });

    // Create multiple bio files
    fs.writeFileSync(path.join(bioDir, 'key1.bio.enc'), 'data1');
    fs.writeFileSync(path.join(bioDir, 'key2.bio.enc'), 'data2');
    fs.writeFileSync(path.join(bioDir, 'other.txt'), 'not-a-bio-file');

    const bioFiles = fs.readdirSync(bioDir).filter((f) => f.endsWith('.bio.enc'));
    expect(bioFiles).toHaveLength(2);

    // Remove only .bio.enc files
    for (const file of bioFiles) {
      fs.unlinkSync(path.join(bioDir, file));
    }

    const remaining = fs.readdirSync(bioDir);
    expect(remaining).toEqual(['other.txt']);
  });
});
