/**
 * Content-table I/O for state-store: reading entries, folders, password_history and vault_meta
 * into a ContentSnapshot (tolerant of older schemas: a missing column reads as NULL, a missing
 * password_history table as empty), and applying a materialize WritePlan in FK-safe order
 * (spec 4.6 step 5). Import through state-store.ts.
 */

import { CONTENT_COLUMNS, TABLE_NAME } from './catalog.js';
import { hasContentTables } from './schema.js';
import { bindValue } from './state-store-codec.js';
import {
  SyncCoreError,
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type EntryRow,
  type FolderRow,
  type HistoryRow,
  type RowKey,
  type SqlValue,
  type WritePlan,
} from './types.js';
import type Database from 'better-sqlite3';

const META_TABLE = 'vault_meta';
const ID_COLUMN = 'id';

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Names of every table in the main schema (one query). */
export function tableNames(db: Database.Database): ReadonlySet<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as unknown[];
  return new Set(rows.filter((n): n is string => typeof n === 'string'));
}

function requireContentTables(db: Database.Database): void {
  if (!hasContentTables(db)) {
    throw new SyncCoreError('UNSUPPORTED_FORMAT', 'state-store: not a vault (vault_meta, entries or folders is missing)');
  }
}

// ---------- Reading ----------

export function loadContent(db: Database.Database): ContentSnapshot {
  return readSnapshot(db, null);
}

/** Content rows of the listed rows only; vault_meta is always included in full. */
export function loadContentRows(db: Database.Database, rows: readonly RowKey[]): ContentSnapshot {
  const ids = new Map<ContentTbl, string[]>([
    [TBL.entries, []],
    [TBL.folders, []],
    [TBL.history, []],
  ]);
  for (const r of rows) ids.get(r.tbl as ContentTbl)?.push(r.rowId);
  return readSnapshot(db, ids);
}

function readSnapshot(db: Database.Database, only: ReadonlyMap<ContentTbl, readonly string[]> | null): ContentSnapshot {
  requireContentTables(db);
  const tables = tableNames(db);
  const read = <R extends ContentRow>(tbl: ContentTbl): Map<string, R> => {
    const ids = only === null ? null : only.get(tbl) ?? [];
    if ((ids !== null && ids.length === 0) || !tables.has(TABLE_NAME[tbl])) return new Map();
    return readTable<R>(db, tbl, ids);
  };
  return {
    entries: read<EntryRow>(TBL.entries),
    folders: read<FolderRow>(TBL.folders),
    history: read<HistoryRow>(TBL.history),
    meta: readMeta(db),
  };
}

function existingColumns(db: Database.Database, table: string): ReadonlySet<string> {
  const info = db.pragma(`table_info(${quote(table)})`) as Array<{ name: unknown }>;
  return new Set(info.map((c) => c.name).filter((n): n is string => typeof n === 'string'));
}

function readTable<R extends ContentRow>(db: Database.Database, tbl: ContentTbl, ids: readonly string[] | null): Map<string, R> {
  const table = TABLE_NAME[tbl];
  const present = existingColumns(db, table);
  if (!present.has(ID_COLUMN)) throw new SyncCoreError('UNSUPPORTED_FORMAT', `state-store: ${table} has no id column`);
  const columns = CONTENT_COLUMNS[tbl];
  const selected = columns.filter((c) => present.has(c));
  const missing = columns.filter((c) => !present.has(c));
  const where = ids === null ? '' : ` WHERE ${quote(ID_COLUMN)} IN (SELECT value FROM json_each(?))`;
  const stmt = db.prepare(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table)}${where}`);
  const raw = (ids === null ? stmt.all() : stmt.all(JSON.stringify(ids))) as Array<Record<string, unknown>>;
  const out = new Map<string, R>();
  let skipped = 0;
  for (const row of raw) {
    const id = row[ID_COLUMN];
    if (typeof id !== 'string' || id.length === 0) {
      skipped++;
      continue;
    }
    for (const c of missing) row[c] = null;
    out.set(id, row as unknown as R);
  }
  if (skipped > 0) console.warn(`[sync] state-store: skipped ${skipped} ${table} row(s) without a usable id`);
  return out;
}

function readMeta(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT key, value FROM ${META_TABLE}`).raw().all() as Array<[unknown, unknown]>;
  const out = new Map<string, string>();
  for (const [key, value] of rows) {
    if (typeof key !== 'string' || value === null || value === undefined) continue;
    out.set(key, typeof value === 'string' ? value : String(value));
  }
  return out;
}

// ---------- Writing ----------

function upsertSql(tbl: ContentTbl): string {
  const cols = CONTENT_COLUMNS[tbl];
  const updates = cols.filter((c) => c !== ID_COLUMN).map((c) => `${quote(c)} = excluded.${quote(c)}`);
  return (
    `INSERT INTO ${quote(TABLE_NAME[tbl])} (${cols.map(quote).join(', ')}) ` +
    `VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${quote(ID_COLUMN)}) DO UPDATE SET ${updates.join(', ')}`
  );
}

const UPSERT_SQL: Readonly<Record<ContentTbl, string>> = {
  1: upsertSql(TBL.entries),
  2: upsertSql(TBL.folders),
  3: upsertSql(TBL.history),
};

function upsertRows(db: Database.Database, tbl: ContentTbl, rows: readonly ContentRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(UPSERT_SQL[tbl]);
  const cols = CONTENT_COLUMNS[tbl];
  for (const row of rows) {
    const cells = row as unknown as Readonly<Record<string, unknown>>;
    stmt.run(cols.map((c) => bindValue(cells[c] as SqlValue | undefined)));
  }
}

function deleteRows(db: Database.Database, tbl: ContentTbl, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`DELETE FROM ${quote(TABLE_NAME[tbl])} WHERE ${quote(ID_COLUMN)} = ?`);
  for (const id of ids) stmt.run(id);
}

function writeMeta(db: Database.Database, meta: ReadonlyMap<string, string | null>): void {
  if (meta.size === 0) return;
  const upsert = db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const remove = db.prepare(`DELETE FROM ${META_TABLE} WHERE key = ?`);
  for (const [key, value] of meta) {
    if (value === null) remove.run(key);
    else upsert.run(key, value);
  }
}

/**
 * FK-safe order (4.6 step 5): upsert folders, entries, history; delete history, entries,
 * folders; then vault_meta. Upserts never use INSERT OR REPLACE, whose implicit delete would
 * fire ON DELETE CASCADE / SET NULL on live rows. The caller owns the transaction.
 */
export function applyWritePlan(db: Database.Database, plan: WritePlan): void {
  db.pragma('defer_foreign_keys = ON');
  upsertRows(db, TBL.folders, plan.upsertFolders);
  upsertRows(db, TBL.entries, plan.upsertEntries);
  upsertRows(db, TBL.history, plan.upsertHistory);
  deleteRows(db, TBL.history, plan.deleteHistory);
  deleteRows(db, TBL.entries, plan.deleteEntries);
  deleteRows(db, TBL.folders, plan.deleteFolders);
  writeMeta(db, plan.meta);
}
