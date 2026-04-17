import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConduitVault as Vault } from '../vault.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-vault-test-'));
}

describe('Vault', () => {
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    vaultPath = path.join(tmpDir, 'test_vault.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize and unlock', () => {
    it('should not exist initially', () => {
      const vault = new Vault(vaultPath);
      expect(vault.exists()).toBe(false);
      expect(vault.isUnlocked()).toBe(false);
    });

    it('should be unlocked after initialization', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('test_master_password');
      expect(vault.exists()).toBe(true);
      expect(vault.isUnlocked()).toBe(true);
    });

    it('should lock and unlock with correct password', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('test_master_password');

      vault.lock();
      expect(vault.isUnlocked()).toBe(false);

      vault.unlock('test_master_password');
      expect(vault.isUnlocked()).toBe(true);
    });

    it('should reject wrong password', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('correct_password');
      vault.lock();

      expect(() => vault.unlock('wrong_password')).toThrow('Invalid master password');
      expect(vault.isUnlocked()).toBe(false);
    });

    it('should not re-initialize an existing vault', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('password');
      expect(() => vault.initialize('password')).toThrow('already exists');
    });

    it('should fail to unlock a non-existent vault', () => {
      const vault = new Vault(vaultPath);
      expect(() => vault.unlock('password')).toThrow('not found');
    });

    it('should be a no-op to unlock an already-unlocked vault', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('password');
      vault.unlock('password'); // should not throw
      expect(vault.isUnlocked()).toBe(true);
    });
  });

  describe('credential CRUD', () => {
    let vault: Vault;

    beforeEach(() => {
      vault = new Vault(vaultPath);
      vault.initialize('test_password');
    });

    afterEach(() => {
      vault.lock();
    });

    it('should create and retrieve a credential', () => {
      const created = vault.createCredential({
        name: 'Test Server',
        username: 'admin',
        password: 'super_secret_password',
        domain: 'example.com',
        tags: ['production', 'linux'],
      });

      expect(created.name).toBe('Test Server');
      expect(created.username).toBe('admin');
      expect(created.password).toBe('super_secret_password');
      expect(created.domain).toBe('example.com');
      expect(created.tags).toEqual(['production', 'linux']);
      expect(created.id).toBeTruthy();

      const retrieved = vault.getCredential(created.id);
      expect(retrieved.name).toBe('Test Server');
      expect(retrieved.username).toBe('admin');
      expect(retrieved.password).toBe('super_secret_password');
      expect(retrieved.domain).toBe('example.com');
      expect(retrieved.tags).toEqual(['production', 'linux']);
    });

    it('should list credentials without secrets', () => {
      vault.createCredential({
        name: 'Cred A',
        password: 'secret_a',
      });
      vault.createCredential({
        name: 'Cred B',
        password: 'secret_b',
      });

      const list = vault.listCredentials();
      expect(list).toHaveLength(2);
      // Should not have password or private_key fields
      for (const meta of list) {
        expect(meta).not.toHaveProperty('password');
        expect(meta).not.toHaveProperty('private_key');
        expect(meta).toHaveProperty('name');
        expect(meta).toHaveProperty('id');
      }
    });

    it('should update a credential', () => {
      const created = vault.createCredential({
        name: 'Original',
        username: 'user1',
        password: 'pass1',
      });

      const updated = vault.updateCredential(created.id, {
        name: 'Updated',
        password: 'new_pass',
      });

      expect(updated.name).toBe('Updated');
      expect(updated.password).toBe('new_pass');
      expect(updated.username).toBe('user1'); // unchanged

      // Verify persistence
      const retrieved = vault.getCredential(created.id);
      expect(retrieved.name).toBe('Updated');
      expect(retrieved.password).toBe('new_pass');
    });

    it('should delete a credential', () => {
      const created = vault.createCredential({
        name: 'To Delete',
        password: 'delete_me',
      });

      vault.deleteCredential(created.id);
      const list = vault.listCredentials();
      expect(list).toHaveLength(0);

      expect(() => vault.getCredential(created.id)).toThrow('not found');
    });

    it('should throw when getting a non-existent credential', () => {
      expect(() => vault.getCredential('non-existent-id')).toThrow('not found');
    });

    it('should throw when deleting a non-existent credential', () => {
      expect(() => vault.deleteCredential('non-existent-id')).toThrow('not found');
    });

    it('should handle credential with private key', () => {
      const created = vault.createCredential({
        name: 'SSH Key',
        username: 'deploy',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake_key_data\n-----END RSA PRIVATE KEY-----',
      });

      const retrieved = vault.getCredential(created.id);
      expect(retrieved.private_key).toContain('BEGIN RSA PRIVATE KEY');
      expect(retrieved.password).toBeNull();
    });

    it('should handle credential with empty tags', () => {
      const created = vault.createCredential({
        name: 'No Tags',
      });

      const retrieved = vault.getCredential(created.id);
      expect(retrieved.tags).toEqual([]);
    });
  });

  describe('locked operations', () => {
    it('should fail all operations when locked', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('test_password');
      vault.lock();

      expect(() => vault.listCredentials()).toThrow('locked');
      expect(() =>
        vault.createCredential({ name: 'Test' })
      ).toThrow('locked');
      expect(() => vault.getCredential('some-id')).toThrow('locked');
      expect(() => vault.deleteCredential('some-id')).toThrow('locked');
    });
  });

  describe('persistence', () => {
    it('should persist credentials across lock/unlock cycles', () => {
      const vault = new Vault(vaultPath);
      vault.initialize('test_password');

      const created = vault.createCredential({
        name: 'Persistent Credential',
        username: 'user',
        password: 'password123',
      });

      vault.lock();
      vault.unlock('test_password');

      const list = vault.listCredentials();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Persistent Credential');

      const retrieved = vault.getCredential(created.id);
      expect(retrieved.password).toBe('password123');
    });

    it('should persist across Vault instances', () => {
      // Create and populate
      const vault1 = new Vault(vaultPath);
      vault1.initialize('test_password');
      vault1.createCredential({
        name: 'Survives Restart',
        password: 'persistent',
      });
      vault1.lock();

      // Re-open
      const vault2 = new Vault(vaultPath);
      vault2.unlock('test_password');

      const list = vault2.listCredentials();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Survives Restart');

      const cred = vault2.getCredential(list[0].id);
      expect(cred.password).toBe('persistent');

      vault2.lock();
    });
  });

});
