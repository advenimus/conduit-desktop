// Shared fixtures for the genesis and candidates tests: legacy content rows, keys, contexts
// and real pre-sync vault files in temp folders.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt } from '../../vault/crypto.js';
import { CREATE_SCHEMA } from '../../vault/schema.js';
import { CONTENT_COLUMNS, TABLE_NAME } from '../catalog.js';
import { deriveEpochKeys, lineageIdFromSalt } from '../hashing.js';
import { ensurePasswordHistory } from '../schema.js';
import {
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type EntryRow,
  type EpochKeys,
  type FolderRow,
  type HistoryRow,
  type KeyRing,
  type SyncContext,
} from '../types.js';

export const SALT = 'c2FsdC1nZW5lc2lzLXRlc3Q=';
export const LINEAGE = lineageIdFromSalt(SALT);
export const KEY0 = Buffer.alloc(32, 7);
export const OLD_KEY = Buffer.alloc(32, 3);
export const STRANGER_KEY = Buffer.alloc(32, 9);
export const K0: EpochKeys = deriveEpochKeys(KEY0, LINEAGE);
export const K_OLD: EpochKeys = deriveEpochKeys(OLD_KEY, LINEAGE);
export const DEVICE_UUID = '11111111-2222-4333-8444-555555555555';
export const GENESIS_ID = 'aa'.repeat(32);
export const OTHER_GENESIS_ID = 'bb'.repeat(32);

export const T0 = Date.UTC(2026, 0, 1);
export const iso = (ms: number): string => new Date(ms).toISOString();
export const DAY = 24 * 60 * 60 * 1000;

export function seal(plain: string, key: Buffer): Buffer {
  return encrypt(Buffer.from(plain, 'utf8'), key);
}

export function verificationToken(key: Buffer): string {
  return seal('conduit-vault-ok', key).toString('base64');
}

export function ring(current: EpochKeys, ...older: EpochKeys[]): KeyRing {
  return { current, byEpoch: new Map([current, ...older].map((k) => [k.epochId, k])) };
}

/** Deterministic randomness: every call returns fresh, distinct bytes. */
export function counterRandom(seed = 'r'): (n: number) => Buffer {
  let i = 0;
  return (n: number) => {
    i += 1;
    const out = Buffer.alloc(n);
    let block = 0;
    for (let off = 0; off < n; off += 32) {
      crypto.createHash('sha256').update(`${seed}:${i}:${block++}`).digest().copy(out, off);
    }
    return out;
  };
}

export function makeCtx(keys: KeyRing, over: Partial<SyncContext> = {}): SyncContext {
  return {
    deviceUuid: DEVICE_UUID,
    lineageId: LINEAGE,
    dev: 77,
    incarnation: 'cc'.repeat(16),
    keys,
    now: () => T0 + 100 * DAY,
    randomBytes: counterRandom(),
    ...over,
  };
}

export function entry(id: string, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    name: `Entry ${id}`,
    entry_type: 'ssh',
    folder_id: null,
    parent_entry_id: null,
    sort_order: 0,
    host: null,
    port: null,
    credential_id: null,
    username: null,
    password_encrypted: null,
    domain: null,
    private_key_encrypted: null,
    totp_secret_encrypted: null,
    icon: null,
    color: null,
    credential_type: null,
    config: '{}',
    tags: '[]',
    is_favorite: 0,
    notes: null,
    created_at: iso(T0),
    updated_at: iso(T0),
    ...over,
  };
}

export function folder(id: string, over: Partial<FolderRow> = {}): FolderRow {
  return {
    id,
    name: `Folder ${id}`,
    parent_id: null,
    sort_order: 0,
    icon: null,
    color: null,
    created_at: iso(T0),
    updated_at: iso(T0),
    ...over,
  };
}

export function history(id: string, entryId: string, over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id,
    entry_id: entryId,
    username: null,
    password_encrypted: null,
    changed_at: iso(T0),
    changed_by: null,
    ...over,
  };
}

export interface SnapshotInput {
  readonly entries?: readonly EntryRow[];
  readonly folders?: readonly FolderRow[];
  readonly history?: readonly HistoryRow[];
  readonly meta?: Readonly<Record<string, string>>;
}

export function snapshot(input: SnapshotInput, key: Buffer = KEY0): ContentSnapshot {
  return {
    entries: new Map((input.entries ?? []).map((r) => [r.id, r])),
    folders: new Map((input.folders ?? []).map((r) => [r.id, r])),
    history: new Map((input.history ?? []).map((r) => [r.id, r])),
    meta: new Map(Object.entries({ schema_version: '10', salt: SALT, verification: verificationToken(key), ...input.meta })),
  };
}

// ---------- Real pre-sync files ----------

export interface TempDir {
  readonly dir: string;
  cleanup(): void;
}

export function tempDir(): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-genesis-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a pre-sync vault (no sync tables) holding exactly `content`, and returns its path. */
export function writeLegacyVault(file: string, content: ContentSnapshot): string {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = OFF');
    db.exec(CREATE_SCHEMA);
    ensurePasswordHistory(db);
    const insertMeta = db.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const [k, v] of content.meta) insertMeta.run(k, v);
      insertRows(db, TBL.folders, [...content.folders.values()]);
      insertRows(db, TBL.entries, [...content.entries.values()]);
      insertRows(db, TBL.history, [...content.history.values()]);
    })();
  } finally {
    db.close();
  }
  return file;
}

function insertRows(db: Database.Database, tbl: ContentTbl, rows: readonly ContentRow[]): void {
  const cols = CONTENT_COLUMNS[tbl];
  const stmt = db.prepare(`INSERT INTO ${TABLE_NAME[tbl]} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    stmt.run(...cols.map((c) => record[c] ?? null));
  }
}
