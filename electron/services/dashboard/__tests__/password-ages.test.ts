// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as crypto from '../../vault/crypto.js';
import { ConduitVault } from '../../vault/vault.js';

let dir: string;
let vault: ConduitVault;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-password-ages-'));
  vault = new ConduitVault(path.join(dir, 'ages.conduit'));
  vault.initialize('test_master_password');
});

afterAll(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setChangedAt(historyId: string, changedAt: string): void {
  vault.getDatabase().raw().prepare('UPDATE password_history SET changed_at = ? WHERE id = ?').run(changedAt, historyId);
}

describe('ConduitVault.listPasswordAges', () => {
  it('lists entries with their own password, from history or creation, without decrypting', () => {
    const never = vault.createEntry({ name: 'never changed', entry_type: 'ssh', host: 'h1', password: 'pw1' });
    const changed = vault.createEntry({ name: 'changed', entry_type: 'rdp', host: 'h2', password: 'old' });
    const older = vault.recordPasswordHistory(changed.id, null, 'older', null);
    const newer = vault.recordPasswordHistory(changed.id, null, 'old', null);
    setChangedAt(older, '2026-01-01T00:00:00.000Z');
    setChangedAt(newer, '2026-03-01T00:00:00.000Z');
    const cred = vault.createCredential({ name: 'Admin', username: 'admin', password: 'secret' });
    const linked = vault.createEntry({ name: 'linked', entry_type: 'ssh', host: 'h3', credential_id: cred.id });
    const noPassword = vault.createEntry({ name: 'key only', entry_type: 'ssh', host: 'h4', username: 'u' });

    const decrypt = vi.spyOn(crypto, 'decrypt');
    const ages = vault.listPasswordAges();
    expect(decrypt).not.toHaveBeenCalled();
    decrypt.mockRestore();

    const byId = new Map(ages.map((a) => [a.entryId, a]));
    expect(byId.get(never.id)).toEqual({ entryId: never.id, setAt: never.created_at, source: 'created' });
    expect(byId.get(changed.id)).toEqual({ entryId: changed.id, setAt: '2026-03-01T00:00:00.000Z', source: 'history' });
    expect(byId.get(cred.id)).toMatchObject({ source: 'created' });
    expect(byId.has(linked.id)).toBe(false);
    expect(byId.has(noPassword.id)).toBe(false);
    expect(ages).toHaveLength(3);
  });

  it('reads vault_id without creating it', () => {
    expect(vault.peekVaultId()).toBeNull();
    const id = vault.getVaultId();
    expect(vault.peekVaultId()).toBe(id);
  });

  it('gives [] while locked', () => {
    const locked = new ConduitVault(path.join(dir, 'locked.conduit'));
    expect(locked.listPasswordAges()).toEqual([]);
    expect(() => locked.peekVaultId()).toThrow('Vault is locked');
  });
});
