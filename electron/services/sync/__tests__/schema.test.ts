// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATE_SCHEMA, SCHEMA_VERSION } from '../../vault/schema.js';
import { MIGRATIONS } from '../../vault/migrations.js';
import {
  PASSWORD_HISTORY_DDL,
  SYNC_DDL,
  SYNC_TABLES,
  ensurePasswordHistory,
  ensureSyncSchema,
  hasContentTables,
  hasSyncTables,
  readSyncFormat,
} from '../schema.js';
import { SYNC_FORMAT, SyncCoreError } from '../types.js';

type Db = Database.Database;

let dir: string;
const open: Db[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-schema-'));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(name: string): Db {
  const db = new Database(path.join(dir, name));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  open.push(db);
  return db;
}

function meta(db: Db, key: string): unknown {
  return (db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: unknown } | undefined)?.value;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO vault_meta(key, value) VALUES (?, ?)').run(key, value);
}

function masterSnapshot(db: Db): unknown[] {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
}

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

function indexExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined;
}

const NOW = '2026-09-25T12:00:00.000Z';

function seedContent(db: Db): void {
  db.prepare('INSERT INTO folders(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('f1', 'Servers', NOW, NOW);
  db.prepare(
    "INSERT INTO entries(id, name, entry_type, folder_id, host, created_at, updated_at) VALUES (?, ?, 'ssh', 'f1', 'h', ?, ?)",
  ).run('e1', 'box', NOW, NOW);
}

/** What database.ts does for a brand-new desktop vault: CREATE_SCHEMA only, stamped 10. */
function freshDesktopVault(): Db {
  const db = openDb('fresh.conduit');
  db.exec('CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(CREATE_SCHEMA);
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  setMeta(db, 'salt', 'c2FsdA==');
  setMeta(db, 'verification', 'dmVyaWZ5');
  seedContent(db);
  return db;
}

/** A v1 desktop file migrated forward by the real MIGRATIONS (so it has vault_sync_meta). */
function migratedDesktopVault(): Db {
  const db = openDb('migrated.conduit');
  db.exec(`
    CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('ssh','rdp','vnc','web','credential')),
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, host TEXT, port INTEGER,
      credential_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
      username TEXT, password_encrypted BLOB, domain TEXT, private_key_encrypted BLOB,
      config TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
      is_favorite INTEGER NOT NULL DEFAULT 0, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  setMeta(db, 'schema_version', '1');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    db.transaction(() => {
      m.up(db);
      setMeta(db, 'schema_version', String(m.version));
    })();
  }
  db.exec(CREATE_SCHEMA);
  db.prepare("INSERT INTO vault_sync_meta(entity_type, entity_id, cloud_version) VALUES ('entry', 'e1', 3)").run();
  seedContent(db);
  return db;
}

/** The DDL iOS 1.0.x runs (VaultDatabase.swift createSchema), stamped 9. */
function iosV9Vault(): Db {
  const db = openDb('ios.conduit');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, sort_order INTEGER DEFAULT 0,
      icon TEXT, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('ssh','rdp','vnc','web','credential','document','command')),
      folder_id TEXT, sort_order INTEGER DEFAULT 0, host TEXT, port INTEGER, username TEXT, domain TEXT,
      password_encrypted BLOB, private_key_encrypted BLOB, totp_secret_encrypted BLOB,
      credential_id TEXT, credential_type TEXT, config TEXT DEFAULT '{}', tags TEXT DEFAULT '[]',
      icon TEXT, color TEXT, is_favorite INTEGER DEFAULT 0, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
      FOREIGN KEY (credential_id) REFERENCES entries(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS password_history (
      id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, username TEXT, password_encrypted BLOB,
      changed_at TEXT NOT NULL, changed_by TEXT,
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE);
    INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('schema_version', '9');
  `);
  seedContent(db);
  return db;
}

const FIXTURES: ReadonlyArray<{ name: string; make: () => Db; schemaVersion: string }> = [
  { name: 'fresh desktop vault (CREATE_SCHEMA only)', make: freshDesktopVault, schemaVersion: String(SCHEMA_VERSION) },
  { name: 'migrated desktop vault (vault_sync_meta present)', make: migratedDesktopVault, schemaVersion: String(SCHEMA_VERSION) },
  { name: 'iOS-created v9 vault', make: iosV9Vault, schemaVersion: '9' },
];

describe.each(FIXTURES)('ensureSyncSchema on a $name', ({ make, schemaVersion }) => {
  it('starts pre-sync', () => {
    const db = make();
    expect(hasContentTables(db)).toBe(true);
    expect(hasSyncTables(db)).toBe(false);
    expect(readSyncFormat(db)).toBeNull();
  });

  it('adds every sync table, stamps sync_format 1 and leaves schema_version and content alone', () => {
    const db = make();
    const entriesBefore = db.prepare('SELECT * FROM entries ORDER BY id').all();
    ensureSyncSchema(db);
    expect(hasSyncTables(db)).toBe(true);
    expect(readSyncFormat(db)).toBe(SYNC_FORMAT);
    expect(meta(db, 'schema_version')).toBe(schemaVersion);
    expect(db.prepare('SELECT * FROM entries ORDER BY id').all()).toEqual(entriesBefore);
    expect(indexExists(db, 'idx_password_history_entry')).toBe(true);
    for (const t of SYNC_TABLES) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('is idempotent', () => {
    const db = make();
    ensureSyncSchema(db);
    const snapshot = masterSnapshot(db);
    ensureSyncSchema(db);
    ensureSyncSchema(db);
    expect(masterSnapshot(db)).toEqual(snapshot);
    expect(readSyncFormat(db)).toBe(SYNC_FORMAT);
    expect(meta(db, 'schema_version')).toBe(schemaVersion);
  });

  it('leaves password_history usable with its foreign key and cascade', () => {
    const db = make();
    ensureSyncSchema(db);
    const insert = db.prepare(
      'INSERT INTO password_history(id, entry_id, username, password_encrypted, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('h1', 'e1', 'root', Buffer.from([1, 2, 3]), NOW, 'user');
    expect(() => insert.run('h2', 'missing', null, null, NOW, null)).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM entries WHERE id = ?').run('e1');
    expect((db.prepare('SELECT COUNT(*) AS n FROM password_history').get() as { n: number }).n).toBe(0);
  });

  it('accepts representative rows in the sync tables', () => {
    const db = make();
    ensureSyncSchema(db);
    const blob16 = Buffer.alloc(16, 0xab);
    db.prepare("INSERT INTO sync_state(key, value) VALUES ('lineage_id', 'L')").run();
    db.prepare('INSERT INTO sync_rowkey(rid, tbl, row_id) VALUES (1, 1, ?)').run('e1');
    db.prepare(
      'INSERT INTO sync_reg(rid, reg, dev, hlc_ms, hlc_c, pid, lt, vhash, flags) VALUES (1, ?, 0, 0, 0, ?, 5, ?, 0)',
    ).run('name', blob16, blob16);
    db.prepare(
      'INSERT INTO sync_sibling(rid, reg, dev, hlc_ms, hlc_c, vhash, value) VALUES (1, ?, 7, 100, 0, ?, ?)',
    ).run('name', blob16, 'text');
    expect(() => db.prepare('INSERT INTO sync_rowkey(rid, tbl, row_id) VALUES (2, 1, ?)').run('e1')).toThrow(/UNIQUE/);
    const sib = db.prepare('SELECT pid, typeof(value) AS t FROM sync_sibling').get() as { pid: Buffer; t: string };
    expect(sib.pid.length).toBe(0);
    expect(sib.t).toBe('text');
  });
});

describe('fixture specifics', () => {
  it('keeps the migrated vault_sync_meta and vault_sync_conflicts tables and their rows', () => {
    const db = migratedDesktopVault();
    ensureSyncSchema(db);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['vault_sync_meta', 'vault_sync_conflicts']));
    expect(db.prepare('SELECT cloud_version FROM vault_sync_meta').get()).toEqual({ cloud_version: 3 });
  });

  it('keeps the iOS password_history definition and only adds the missing index', () => {
    const db = iosV9Vault();
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'password_history'").get();
    expect(indexExists(db, 'idx_password_history_entry')).toBe(false);
    ensureSyncSchema(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'password_history'").get()).toEqual(before);
    expect(indexExists(db, 'idx_password_history_entry')).toBe(true);
  });

  it('never overwrites an existing sync_format value', () => {
    const db = freshDesktopVault();
    setMeta(db, 'sync_format', '1');
    ensureSyncSchema(db);
    expect(meta(db, 'sync_format')).toBe('1');
  });
});

describe('ensurePasswordHistory', () => {
  it('adds only the table and index to a fresh desktop vault', () => {
    const db = freshDesktopVault();
    expect(tableNames(db)).not.toContain('password_history');
    ensurePasswordHistory(db);
    ensurePasswordHistory(db);
    expect(tableNames(db)).toContain('password_history');
    expect(indexExists(db, 'idx_password_history_entry')).toBe(true);
    expect(hasSyncTables(db)).toBe(false);
    expect(readSyncFormat(db)).toBeNull();
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
  });

  it('matches the password_history statements inside SYNC_DDL', () => {
    expect(SYNC_DDL).toContain(PASSWORD_HISTORY_DDL.trim());
    expect(SYNC_DDL).toContain(`VALUES ('sync_format', '${SYNC_FORMAT}')`);
  });
});

describe('refusals and transactions', () => {
  it('refuses a file without content tables', () => {
    const db = openDb('other.sqlite');
    db.exec('CREATE TABLE notes(x)');
    expect(hasContentTables(db)).toBe(false);
    expect(() => ensureSyncSchema(db)).toThrow(SyncCoreError);
    expect(() => ensurePasswordHistory(db)).toThrow(SyncCoreError);
    expect(tableNames(db)).toEqual(['notes']);
  });

  it('refuses a newer sync_format without creating anything', () => {
    const db = freshDesktopVault();
    setMeta(db, 'sync_format', '2');
    const snapshot = masterSnapshot(db);
    let err: unknown = null;
    try {
      ensureSyncSchema(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncCoreError);
    expect((err as SyncCoreError).code).toBe('UNSUPPORTED_FORMAT');
    expect(masterSnapshot(db)).toEqual(snapshot);
  });

  it("joins the caller's open transaction", () => {
    const db = freshDesktopVault();
    db.exec('BEGIN IMMEDIATE');
    ensureSyncSchema(db);
    expect(hasSyncTables(db)).toBe(true);
    db.exec('ROLLBACK');
    expect(hasSyncTables(db)).toBe(false);
    expect(readSyncFormat(db)).toBeNull();
  });

  it('applies nothing when a statement fails half way', () => {
    const db = freshDesktopVault();
    db.exec('CREATE INDEX sync_row ON folders(name)');
    const snapshot = masterSnapshot(db);
    expect(() => ensureSyncSchema(db)).toThrow(/sync_row/);
    expect(masterSnapshot(db)).toEqual(snapshot);
    expect(readSyncFormat(db)).toBeNull();
  });
});

describe('readSyncFormat', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
    ['abc', null],
    ['', null],
    ['1.5', null],
    ['-1', null],
    ['99999999999999999999', null],
  ])('reads %j as %j', (text, expected) => {
    const db = freshDesktopVault();
    setMeta(db, 'sync_format', text);
    expect(readSyncFormat(db)).toBe(expected);
  });

  it('treats NULL (iOS vault_meta allows it), absent key and missing table as pre-sync', () => {
    const ios = iosV9Vault();
    ios.prepare("INSERT INTO vault_meta(key, value) VALUES ('sync_format', NULL)").run();
    expect(readSyncFormat(ios)).toBeNull();
    expect(readSyncFormat(freshDesktopVault())).toBeNull();
    const empty = openDb('empty.sqlite');
    expect(readSyncFormat(empty)).toBeNull();
  });

  it('reads an integer-typed value', () => {
    const ios = iosV9Vault();
    ios.prepare("INSERT INTO vault_meta(key, value) VALUES ('sync_format', 1)").run();
    expect(readSyncFormat(ios)).toBe(1);
  });
});

describe('table presence', () => {
  it('reports sync tables missing when any one is absent', () => {
    const db = freshDesktopVault();
    ensureSyncSchema(db);
    db.exec('DROP TABLE sync_key_wrap');
    expect(hasSyncTables(db)).toBe(false);
  });

  it('requires vault_meta, entries and folders for a vault', () => {
    const db = freshDesktopVault();
    db.exec('DROP TABLE folders');
    expect(hasContentTables(db)).toBe(false);
  });
});
