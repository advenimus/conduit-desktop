// @vitest-environment node
// Backup restores for synced vaults (spec 5.10, 12 row 20) on real vault files: the rollback
// preview lists deletions, restorations and replacements; applying it (one interactive dot)
// converges content to the backup, saves every replaced password to password_history with
// changed_by 'rollback', skips and counts backup secrets no key opens; restore as a new vault
// forks the backup into a new lineage and leaves the backup untouched.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { deriveKey } from '../../vault/crypto.js';
import { CHANGED_BY_ROLLBACK, readBackupContent, restoreAsNewVault, rollbackChange, rollbackPreview, rollbackWrites, type RollbackInput } from '../restore.js';
import { loadContent } from '../state-store.js';
import type { ContentSnapshot, EntryRow } from '../types.js';
import type { SimDevice } from './core-e2e-harness.js';
import { NEW_PASSWORD, OLD_PASSWORD, decryptAllSecrets, entryRow, historyIds } from './core-e2e-fixtures.js';
import { makeTestSyncHost, type TestSyncHost } from './host-fakes.js';
import { advance, converge, setupWorld, teardownWorld, type World } from './sim-world.js';

const SECRET_COLUMNS = ['password_encrypted', 'private_key_encrypted', 'totp_secret_encrypted'];

let w: World | null = null;
let t: TestSyncHost;
let workDir: string;

beforeEach(() => {
  w = setupWorld();
  t = makeTestSyncHost(w.root);
  workDir = path.join(w.root, 'restore-work');
});

afterEach(() => {
  expect(t.logger.unprefixed()).toEqual([]);
  teardownWorld(w);
  w = null;
});

const derive = (password: string) => (salt: string): Buffer => deriveKey(password, Buffer.from(salt, 'base64'));

function backupOf(dev: SimDevice, name: string): string {
  const file = path.join(w!.root, name);
  dev.db.prepare('VACUUM INTO ?').run(file);
  return file;
}

function inputFor(dev: SimDevice, backup: RollbackInput['backup']): RollbackInput {
  return { backup, current: dev.state, ctx: dev.ctx, implicit: dev.implicit };
}

/** Entries and folders without updated_at and secret ciphertexts (secrets compared decrypted). */
function comparable(content: ContentSnapshot): Record<string, unknown> {
  const strip = (row: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'updated_at' && !SECRET_COLUMNS.includes(k)));
  const rows = (m: ReadonlyMap<string, object>) => [...m.keys()].sort().map((id) => strip(m.get(id) as object));
  return { entries: rows(content.entries), folders: rows(content.folders) };
}

function fileContent(file: string): ContentSnapshot {
  const db = new Database(file, { readonly: true });
  try {
    return loadContent(db);
  } finally {
    db.close();
  }
}

function entrySecrets(db: Database.Database, key: Buffer): Map<string, string> {
  return new Map([...decryptAllSecrets(db, key)].filter(([k]) => k.startsWith('entries.')));
}

describe('rollback preview and writes', () => {
  it('lists deletions, restorations and replacements, then converges content to the backup', async () => {
    const { a, b } = w!;
    const ids = w!.fixture.ids;
    const backupPath = backupOf(a, 'backup.conduit');
    advance(w!);
    let laterId = '';
    a.edit((v) => {
      laterId = v.createEntry({ name: 'created later', entry_type: 'ssh', host: 'later.local' }).id;
      v.deleteEntry(ids.desk);
      v.updateEntry(ids.web, { host: '10.0.0.9', password: 'pw-web-2' });
      v.updateEntry(ids.db, { notes: 'noted later' });
      v.recordPasswordHistory(ids.web, 'root', 'pw-web-mid', 'user');
    }, true);

    const backup = await readBackupContent(backupPath, workDir, derive(OLD_PASSWORD), t.host);
    expect(backup.keys?.epochId).toBe(a.keys.current.epochId);
    expect(fs.readdirSync(workDir)).toEqual([]);

    const preview = rollbackPreview(inputFor(a, backup));
    expect(preview.deletions).toEqual([{ row: { tbl: 1, rowId: laterId }, title: 'created later' }]);
    expect(preview.restorations).toEqual([{ row: { tbl: 1, rowId: ids.desk }, title: 'desk' }]);
    const replaced = preview.replacements.map((f) => ({ id: f.key.rowId, reg: f.key.reg, current: f.current, incoming: f.incoming, masked: f.masked }));
    expect(replaced).toEqual(
      expect.arrayContaining([
        { id: ids.web, reg: 'host', current: '10.0.0.9', incoming: '10.0.0.1', masked: false },
        { id: ids.web, reg: 'password', current: null, incoming: null, masked: true },
        { id: ids.db, reg: 'notes', current: 'noted later', incoming: null, masked: false },
      ]),
    );
    expect(replaced).toHaveLength(3);
    expect(preview.replacements.find((f) => f.key.reg === 'host')?.rowTitle).toBe('web');
    expect(preview.unreadableSecrets).toBe(0);

    const writes = rollbackWrites(inputFor(a, backup));
    expect(writes.every((x) => x.mode === 'replace-all')).toBe(true);
    expect(writes.some((x) => x.key.tbl === 4 || x.key.tbl === 9)).toBe(false);
    a.write(writes);

    const key = a.keys.current.kEpoch;
    expect(comparable(loadContent(a.db))).toEqual(comparable(fileContent(backupPath)));
    const backupDb = new Database(backupPath, { readonly: true });
    expect(entrySecrets(a.db, key)).toEqual(entrySecrets(backupDb, key));
    backupDb.close();
    expect(entryRow(a.db, laterId)).toBeUndefined();
    expect(a.vault.getEntry(ids.web).password).toBe('pw-web');
    expect(a.vault.getEntry(ids.desk)).toMatchObject({ name: 'desk', host: 'desk.local' });

    const history = a.vault.listPasswordHistory(ids.web);
    expect(history.filter((h) => h.changed_by === CHANGED_BY_ROLLBACK)).toEqual([
      expect.objectContaining({ entry_id: ids.web, username: 'root', password: 'pw-web-2' }),
    ]);
    expect(history.map((h) => h.password)).toEqual(expect.arrayContaining(['pw-web-old', 'pw-web-mid']));

    converge(w!);
    expect(b.vault.getEntry(ids.web)).toMatchObject({ host: '10.0.0.1', password: 'pw-web' });
    expect(entryRow(b.db, laterId)).toBeUndefined();
    expect(historyIds(b.db)).toHaveLength(historyIds(a.db).length);
  });

  it('counts what the user rolls back as the preview lists it, not register writes', async () => {
    const { a } = w!;
    const ids = w!.fixture.ids;
    const backupPath = backupOf(a, 'count.conduit');
    advance(w!);
    a.edit((v) => {
      v.updateEntry(ids.web, { password: 'pw-web-2' });
      v.deleteEntry(ids.desk);
    }, true);

    const backup = await readBackupContent(backupPath, workDir, derive(OLD_PASSWORD), t.host);
    const preview = rollbackPreview(inputFor(a, backup));
    expect(preview.restorations.map((r) => r.title)).toEqual(['desk']);
    expect(preview.replacements.map((f) => `${f.rowTitle}/${f.key.reg}`)).toEqual(['web/password']);
    const change = rollbackChange(inputFor(a, backup));
    expect(change.changes).toBe(2);
    expect(change.writes.length).toBeGreaterThan(2);
  });

  it('skips and counts backup secrets no key opens, and leaves those fields alone', async () => {
    const { a } = w!;
    const ids = w!.fixture.ids;
    const backupPath = backupOf(a, 'damaged-secret.conduit');
    const raw = new Database(backupPath);
    raw.prepare('UPDATE entries SET password_encrypted = ? WHERE id = ?').run(crypto.randomBytes(44), ids.db);
    raw.close();
    advance(w!);
    a.edit((v) => v.updateEntry(ids.db, { host: '10.0.0.77' }), true);

    const backup = await readBackupContent(backupPath, workDir, derive(OLD_PASSWORD), t.host);
    const preview = rollbackPreview(inputFor(a, backup));
    expect(preview.unreadableSecrets).toBe(1);
    expect(preview.replacements.map((f) => `${f.key.rowId}/${f.key.reg}`)).toEqual([`${ids.db}/host`]);
    const writes = rollbackWrites(inputFor(a, backup));
    expect(writes.map((x) => x.key.reg)).toEqual(['host']);
    a.write(writes);
    expect(a.vault.getEntry(ids.db)).toMatchObject({ host: '10.0.0.5', password: 'pw-db' });
  });

  it('reads a backup made under another password through the vault ring; keys stay null', async () => {
    const { a } = w!;
    const ids = w!.fixture.ids;
    const backupPath = backupOf(a, 'old-password.conduit');
    advance(w!);
    a.changePassword(NEW_PASSWORD);
    a.edit((v) => v.updateEntry(ids.cred, { password: 'cred-pw-2' }), true);

    const backup = await readBackupContent(backupPath, workDir, derive(NEW_PASSWORD), t.host);
    expect(backup.keys).toBeNull();
    expect(t.logger.messages('info')).toContain('[sync] backup uses another password; its secrets are read with the vault\'s keys only');
    const preview = rollbackPreview(inputFor(a, backup));
    expect(preview.unreadableSecrets).toBe(0);
    expect(preview.replacements.map((f) => `${f.key.rowId}/${f.key.reg}`)).toEqual([`${ids.cred}/password`]);
    a.write(rollbackWrites(inputFor(a, backup)));
    expect(a.vault.getEntry(ids.cred).password).toBe('cred-pw');
    expect(a.vault.listPasswordHistory(ids.cred)).toEqual([
      expect.objectContaining({ username: 'admin', password: 'cred-pw-2', changed_by: CHANGED_BY_ROLLBACK }),
    ]);
  });

  it('reads a pre-sync backup with its own keys', async () => {
    const legacyPath = path.join(w!.root, 'legacy-backup.conduit');
    fs.writeFileSync(legacyPath, w!.fixture.source.bytes);
    const backup = await readBackupContent(legacyPath, workDir, derive(OLD_PASSWORD), t.host);
    expect(backup.keys?.epochId).toBe(w!.a.keys.current.epochId);
    expect([...backup.content.entries.values()].map((e: EntryRow) => e.name).sort()).toEqual(['Shared admin', 'db', 'desk', 'web']);
    expect(rollbackPreview(inputFor(w!.a, backup))).toMatchObject({ deletions: [], restorations: [], replacements: [], unreadableSecrets: 0 });
  });

  it('refuses files that are not vaults and cleans up its staged copy', async () => {
    const notVault = path.join(w!.root, 'other.sqlite');
    const db = new Database(notVault);
    db.exec('CREATE TABLE notes (x TEXT)');
    db.close();
    await expect(readBackupContent(notVault, workDir, derive(OLD_PASSWORD), t.host)).rejects.toThrow('[sync] backup is not a Conduit vault');
    const garbage = path.join(w!.root, 'garbage.conduit');
    fs.writeFileSync(garbage, crypto.randomBytes(4096));
    await expect(readBackupContent(garbage, workDir, derive(OLD_PASSWORD), t.host)).rejects.toThrow();
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(t.logger.messages('error')).toEqual(['[sync] backup read failed', '[sync] backup read failed']);
  });
});

describe('restore as a new vault', () => {
  it('forks the backup into a new lineage that opens with the same password; the backup is untouched', async () => {
    const { a } = w!;
    const backupPath = backupOf(a, 'backup.conduit');
    const before = fs.readFileSync(backupPath);
    const target = path.join(w!.root, 'Restored.conduit');
    const res = await restoreAsNewVault(backupPath, a.keys.current.kEpoch, target, workDir, t.host);
    expect(res.path).toBe(target);
    expect(res.lineageId).not.toBe(a.state.lineageId);
    expect(fs.readFileSync(backupPath).equals(before)).toBe(true);
    const vault = new ConduitVault(target);
    vault.unlock(OLD_PASSWORD);
    expect(vault.getEntry(w!.fixture.ids.web).password).toBe('pw-web');
    expect(vault.getVaultId()).toBe(res.vaultId);
    vault.lock();
    await expect(restoreAsNewVault(backupPath, a.keys.current.kEpoch, target, workDir, t.host)).rejects.toThrow();
    expect(t.logger.messages('error')).toContain('[sync] restore as a new vault failed');
  });
});
