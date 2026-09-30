/**
 * Sync DDL of spec 3.3, run idempotently inside a `.conduit` file (never touches
 * schema_version), the password_history fix for fresh desktop vaults, and sync_format checks
 * used by classify (5.2, 5.12). The Swift port runs the identical statements.
 */

import type Database from 'better-sqlite3';
import { SYNC_FORMAT, SyncCoreError } from './types.js';

export const SYNC_TABLES = [
  'sync_state',
  'sync_vv',
  'sync_dev',
  'sync_rowkey',
  'sync_reg',
  'sync_sibling',
  'sync_row',
  'sync_grave',
  'sync_key_epoch',
  'sync_key_wrap',
] as const;

/** sync_state keys. */
export const SYNC_STATE_KEYS = {
  lineageId: 'lineage_id',
  genesisId: 'genesis_id',
  createdMs: 'created_ms',
  fileId: 'file_id',
} as const;

/** The exact spec 3.3 statements, including the password_history fix and sync_format = '1'. */
export const SYNC_DDL = `
INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('sync_format', '1');

CREATE TABLE IF NOT EXISTS password_history (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  username TEXT, password_encrypted BLOB, changed_at TEXT NOT NULL, changed_by TEXT);
CREATE INDEX IF NOT EXISTS idx_password_history_entry ON password_history(entry_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_vv (
  dev INTEGER PRIMARY KEY, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sync_dev (
  dev INTEGER PRIMARY KEY, device_uuid TEXT NOT NULL, started_ms INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sync_rowkey (
  rid INTEGER PRIMARY KEY, tbl INTEGER NOT NULL, row_id TEXT NOT NULL, UNIQUE (tbl, row_id));

CREATE TABLE IF NOT EXISTS sync_reg (
  rid INTEGER NOT NULL,
  reg TEXT NOT NULL,
  dev INTEGER NOT NULL, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
  pid BLOB,
  lt INTEGER NOT NULL DEFAULT 0,
  vhash BLOB NOT NULL,
  prev_vhash BLOB,
  flags INTEGER NOT NULL DEFAULT 0,
  pmem_ms INTEGER,
  pmem_ids BLOB,
  mat TEXT,
  PRIMARY KEY (rid, reg)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_sibling (
  rid INTEGER NOT NULL, reg TEXT NOT NULL,
  dev INTEGER NOT NULL, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
  pid BLOB NOT NULL DEFAULT x'',
  lt INTEGER NOT NULL DEFAULT 0,
  vhash BLOB NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  value BLOB,
  PRIMARY KEY (rid, reg, dev, hlc_ms, hlc_c, pid)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_row (
  rid INTEGER PRIMARY KEY,
  materialized INTEGER NOT NULL DEFAULT 0,
  raw_hash BLOB);

CREATE TABLE IF NOT EXISTS sync_grave (
  rid INTEGER PRIMARY KEY,
  row_json TEXT,
  died_ms INTEGER NOT NULL, died_c INTEGER NOT NULL, died_dev INTEGER NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sync_key_epoch (
  epoch_id TEXT PRIMARY KEY,
  parent_epoch TEXT,
  salt TEXT,
  verification TEXT,
  created_ms INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_key_wrap (
  epoch_id TEXT NOT NULL,
  target_epoch TEXT NOT NULL,
  wrap BLOB NOT NULL,
  PRIMARY KEY (epoch_id, target_epoch, wrap)) WITHOUT ROWID;
`;


/** Only the password_history statements of SYNC_DDL (3.3 fix), for files that stay pre-sync. */
export const PASSWORD_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS password_history (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  username TEXT, password_encrypted BLOB, changed_at TEXT NOT NULL, changed_by TEXT);
CREATE INDEX IF NOT EXISTS idx_password_history_entry ON password_history(entry_id, changed_at DESC);
`;

export const SYNC_FORMAT_KEY = 'sync_format';
export const CONTENT_TABLES = ['vault_meta', 'entries', 'folders'] as const;

const UNSIGNED_INT_RE = /^[0-9]+$/;

/**
 * Runs SYNC_DDL (idempotent). Joins the caller's transaction when one is open, otherwise runs
 * in its own, so a failure never leaves half the tables behind. Refuses files that are not
 * vaults or that carry a newer sync_format (5.2: foreign, never written).
 */
export function ensureSyncSchema(db: Database.Database): void {
  requireContentTables(db);
  const format = readSyncFormat(db);
  if (format !== null && format > SYNC_FORMAT) {
    throw new SyncCoreError('UNSUPPORTED_FORMAT', `sync_format ${format} is newer than ${SYNC_FORMAT}`);
  }
  runDdl(db, SYNC_DDL);
}

/** Only the password_history table and index (3.3 fix), for files that stay pre-sync. */
export function ensurePasswordHistory(db: Database.Database): void {
  requireContentTables(db);
  runDdl(db, PASSWORD_HISTORY_DDL);
}

/** vault_meta.sync_format as an integer; null when absent (pre-sync); NaN-safe (bad text -> null). */
export function readSyncFormat(db: Database.Database): number | null {
  if (!tableExists(db, 'vault_meta')) return null;
  const row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(SYNC_FORMAT_KEY) as
    | { value: unknown }
    | undefined;
  return row === undefined ? null : parseFormat(row.value);
}

/** True when every table in SYNC_TABLES exists. */
export function hasSyncTables(db: Database.Database): boolean {
  return countTables(db, SYNC_TABLES) === SYNC_TABLES.length;
}

/** Content tables present (vault_meta, entries, folders); a file without them is not a vault. */
export function hasContentTables(db: Database.Database): boolean {
  return countTables(db, CONTENT_TABLES) === CONTENT_TABLES.length;
}

function requireContentTables(db: Database.Database): void {
  if (!hasContentTables(db)) {
    throw new SyncCoreError('UNSUPPORTED_FORMAT', 'not a vault: vault_meta, entries or folders is missing');
  }
}

function runDdl(db: Database.Database, ddl: string): void {
  if (db.inTransaction) {
    db.exec(ddl);
    return;
  }
  db.transaction(() => db.exec(ddl))();
}

function parseFormat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!UNSIGNED_INT_RE.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function tableExists(db: Database.Database, name: string): boolean {
  return countTables(db, [name]) === 1;
}

function countTables(db: Database.Database, names: readonly string[]): number {
  const placeholders = names.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .get(...names) as { n: number };
  return row.n;
}
