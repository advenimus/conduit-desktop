// @vitest-environment node
// ConduitDatabase options and helpers, biometric key moves, and the network/cloud path test.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitDatabase } from '../database.js';
import { biometricFilePath, moveKeyFile, removeAllKeyFiles, vaultLineageToKey } from '../biometric-keys.js';
import { NetworkLockService } from '../network-lock.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-vault-files-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

describe('ConduitDatabase', () => {
  it('gives fresh vaults a password_history table and no sync tables', () => {
    const db = new ConduitDatabase(path.join(dir, 'fresh.conduit'));
    const names = tables(db.raw());
    expect(names).toContain('password_history');
    expect(names.some((n) => n.startsWith('sync_'))).toBe(false);
    expect(db.getMeta('sync_format')).toBeUndefined();
    db.close();
  });

  it('honors the journal mode and refuses a missing file when create is false', () => {
    const db = new ConduitDatabase(path.join(dir, 'net.conduit'), { journalMode: 'delete' });
    expect(db.raw().pragma('journal_mode', { simple: true })).toBe('delete');
    db.close();
    expect(() => new ConduitDatabase(path.join(dir, 'missing.conduit'), { create: false })).toThrow();
    expect(fs.existsSync(path.join(dir, 'missing.conduit'))).toBe(false);
  });

  it('vacuums into a new file only outside a transaction', () => {
    const db = new ConduitDatabase(path.join(dir, 'src.conduit'));
    db.setMeta('marker', 'yes');
    const target = path.join(dir, 'copy.conduit');
    expect(() => db.runInTransaction(() => db.vacuumInto(path.join(dir, 'nope.conduit')))).toThrow('VACUUM INTO cannot run inside a transaction');
    db.vacuumInto(target);
    db.close();
    const copy = new Database(target, { readonly: true });
    expect((copy.prepare('SELECT value FROM vault_meta WHERE key = ?').get('marker') as { value: string }).value).toBe('yes');
    copy.close();
  });

  it('returns the ids a recursive folder delete removed', () => {
    const db = new ConduitDatabase(path.join(dir, 'f.conduit'));
    const now = '2026-01-01T00:00:00.000Z';
    const folder = (id: string, parent: string | null) =>
      db.insertFolder({ id, name: id, parent_id: parent, sort_order: 0, icon: null, color: null, created_at: now, updated_at: now });
    const entry = (id: string, folderId: string | null, parent: string | null) =>
      db.insertEntry({
        id,
        name: id,
        entry_type: 'ssh',
        folder_id: folderId,
        parent_entry_id: parent,
        sort_order: 0,
        host: null,
        port: null,
        credential_id: null,
        username: null,
        password_encrypted: null,
        domain: null,
        private_key_encrypted: null,
        icon: null,
        color: null,
        config: '{}',
        tags: '[]',
        is_favorite: 0,
        notes: null,
        created_at: now,
        updated_at: now,
      });
    folder('a', null);
    folder('b', 'a');
    folder('other', null);
    entry('e1', 'b', null);
    entry('e2', null, 'e1');
    entry('keep', 'other', null);
    db.insertPasswordHistory({ id: 'h1', entry_id: 'e2', username: null, password_encrypted: null, changed_at: now, changed_by: null });
    const res = db.deleteFolderRecursive('a');
    expect(res.foldersDeleted).toBe(2);
    expect(res.entriesDeleted).toBe(2);
    expect([...res.folderIds].sort()).toEqual(['a', 'b']);
    expect([...res.entryIds].sort()).toEqual(['e1', 'e2']);
    expect(res.historyIds).toEqual(['h1']);
    expect(db.listEntries().map((e) => e.id)).toEqual(['keep']);
    db.close();
  });
});

describe('biometric keys', () => {
  it('derives a stable lineage key that differs from the path key scheme', () => {
    const k = vaultLineageToKey('11111111-1111-4111-8111-111111111111');
    expect(k).toMatch(/^[a-f0-9]{64}$/);
    expect(vaultLineageToKey('11111111-1111-4111-8111-111111111111')).toBe(k);
    expect(vaultLineageToKey('22222222-2222-4222-8222-222222222222')).not.toBe(k);
  });

  it('moves a path-keyed entry once and never overwrites a lineage-keyed one', () => {
    fs.writeFileSync(biometricFilePath(dir, 'path'), 'old');
    expect(moveKeyFile(dir, 'path', 'lineage')).toBe(true);
    expect(fs.readFileSync(biometricFilePath(dir, 'lineage'), 'utf8')).toBe('old');
    expect(fs.existsSync(biometricFilePath(dir, 'path'))).toBe(false);

    fs.writeFileSync(biometricFilePath(dir, 'path'), 'stale');
    expect(moveKeyFile(dir, 'path', 'lineage')).toBe(false);
    expect(fs.readFileSync(biometricFilePath(dir, 'lineage'), 'utf8')).toBe('old');
    expect(moveKeyFile(dir, 'absent', 'x')).toBe(false);
    expect(moveKeyFile(path.join(dir, 'no-such-dir'), 'a', 'b')).toBe(false);
  });

  it('clearing the recent list removes lineage-keyed and path-keyed entries, nothing else', () => {
    const lineageFile = biometricFilePath(dir, vaultLineageToKey('11111111-1111-4111-8111-111111111111'));
    const pathFile = biometricFilePath(dir, 'path');
    const other = path.join(dir, 'notes.txt');
    for (const f of [lineageFile, pathFile, other]) fs.writeFileSync(f, 'x');
    removeAllKeyFiles(dir);
    expect(fs.existsSync(lineageFile)).toBe(false);
    expect(fs.existsSync(pathFile)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(() => removeAllKeyFiles(path.join(dir, 'no-such-dir'))).not.toThrow();
  });
});

describe('isNetworkPath (spec 5.4 additions)', () => {
  it('recognizes CloudStorage, iCloud for Windows, Box, Nextcloud and Synology folders', () => {
    const yes = [
      '/Users/me/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/v.conduit',
      'C:\\Users\\me\\iCloudDrive\\v.conduit',
      'C:\\Users\\me\\iCloud Drive\\v.conduit',
      '/Users/me/Box/v.conduit',
      '/home/me/Nextcloud/v.conduit',
      'C:\\Users\\me\\SynologyDrive\\v.conduit',
      '/Users/me/Dropbox/v.conduit',
    ];
    for (const p of yes) expect(NetworkLockService.isNetworkPath(p), p).toBe(true);
    expect(NetworkLockService.isNetworkPath('/Users/me/Documents/v.conduit')).toBe(false);
    expect(NetworkLockService.isNetworkPath('/Users/me/Boxes/v.conduit')).toBe(false);
  });
});
