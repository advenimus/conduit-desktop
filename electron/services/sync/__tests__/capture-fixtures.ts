// Shared fixtures for the capture tests: real ConduitVault files in temp folders, content
// snapshots read back with a raw better-sqlite3 connection, keys, contexts, and a loader
// simulation that reads head values from (possibly changed) content like state-store does.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConduitVault } from '../../vault/vault.js';
import { encrypt } from '../../vault/crypto.js';
import { captureFullPass } from '../capture-local.js';
import {
  CONTENT_TBLS,
  META_ROW_ID,
  TABLE_NAME,
  readContentRow,
  readMetaRegisters,
  rowKey,
} from '../catalog.js';
import { deriveEpochKeys, makeImplicitProvider, rawHash } from '../hashing.js';
import { StateBuilder, emptyState, headOf, rowKeyStr } from '../state-view.js';
import {
  TBL,
  type AppDot,
  type ContentRow,
  type ContentSnapshot,
  type EntryRow,
  type EpochKeys,
  type FolderRow,
  type HistoryRow,
  type KeyRing,
  type LegacyAttribution,
  type RowCache,
  type RowCacheEntry,
  type SyncContext,
  type SyncState,
  type SyncValue,
} from '../types.js';

export const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
export const GENESIS = 'ab'.repeat(32);
export const DEVICE_A = '11111111-1111-4111-8111-111111111111';
export const DEV_A = 101;
export const DEV_B = 202;

export const K_CURRENT = Buffer.alloc(32, 7);
export const K_OLDER = Buffer.alloc(32, 9);
export const K_UNKNOWN = Buffer.alloc(32, 11);

export const PASSWORD_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS password_history (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    username TEXT, password_encrypted BLOB, changed_at TEXT NOT NULL, changed_by TEXT);
  CREATE INDEX IF NOT EXISTS idx_password_history_entry ON password_history(entry_id, changed_at DESC);
`;

export function epochKeys(k: Buffer): EpochKeys {
  return deriveEpochKeys(k, LINEAGE);
}

export function ringOf(current: EpochKeys, ...others: EpochKeys[]): KeyRing {
  const byEpoch = new Map<string, EpochKeys>([[current.epochId, current]]);
  for (const k of others) byEpoch.set(k.epochId, k);
  return { current, byEpoch };
}

export interface TestCtx extends SyncContext {
  /** Mutable wall clock the context's now() reads. */
  readonly clock: { now: number };
}

export function makeCtx(opts: { dev?: number; keys?: KeyRing; nowMs?: number } = {}): TestCtx {
  const clock = { now: opts.nowMs ?? Date.parse('2026-09-25T12:00:00.000Z') };
  return {
    deviceUuid: DEVICE_A,
    lineageId: LINEAGE,
    dev: opts.dev ?? DEV_A,
    incarnation: 'cd'.repeat(16),
    keys: opts.keys ?? ringOf(epochKeys(K_CURRENT)),
    now: () => clock.now,
    randomBytes: (n: number) => crypto.randomBytes(n),
    clock,
  };
}

export function dot(dev: number, ms: number, c = 0): AppDot {
  return { dev, ms, c };
}

export function implicitFor(ctx: Pick<SyncContext, 'keys'>): ReturnType<typeof makeImplicitProvider> {
  return makeImplicitProvider(ctx.keys.current.kSync);
}

// ---------- Vault files ----------

export interface VaultFixture {
  readonly dir: string;
  readonly file: string;
  readonly vault: ConduitVault;
  /** A second, raw connection: reads content and plays the legacy writer (foreign keys on). */
  readonly raw: Database.Database;
  close(): void;
}

export function createVault(key: Buffer = K_CURRENT): VaultFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-capture-'));
  const file = path.join(dir, 'vault.conduit');
  const vault = new ConduitVault(file);
  vault.initializeWithKey(key);
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(PASSWORD_HISTORY_DDL);
  return {
    dir,
    file,
    vault,
    raw,
    close() {
      if (vault.isUnlocked()) vault.lock();
      if (raw.open) raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tableRows<T extends ContentRow>(raw: Database.Database, table: string): Map<string, T> {
  const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return new Map();
  const rows = raw.prepare(`SELECT * FROM ${table}`).all() as T[];
  return new Map(rows.map((r) => [r.id, r]));
}

export function readContent(raw: Database.Database): ContentSnapshot {
  const meta = raw.prepare('SELECT key, value FROM vault_meta').all() as Array<{ key: string; value: string }>;
  return {
    entries: tableRows<EntryRow>(raw, TABLE_NAME[TBL.entries]),
    folders: tableRows<FolderRow>(raw, TABLE_NAME[TBL.folders]),
    history: tableRows<HistoryRow>(raw, TABLE_NAME[TBL.history]),
    meta: new Map(meta.map((m) => [m.key, m.value])),
  };
}

/** The cache materialize would write for this content: every row materialized with its raw hash. */
export function cacheFor(content: ContentSnapshot): RowCache {
  const out = new Map<string, RowCacheEntry>();
  for (const tbl of CONTENT_TBLS) {
    const rows = tbl === TBL.entries ? content.entries : tbl === TBL.folders ? content.folders : content.history;
    for (const row of rows.values()) out.set(rowKeyStr(rowKey(tbl, row.id)), { materialized: true, rawHash: rawHash(tbl, row) });
  }
  return out;
}

/** An app device's first capture of the content (every row an insert) plus the matching cache. */
export function initialState(
  content: ContentSnapshot,
  ctx: TestCtx,
  ms = 1_000,
): { readonly state: SyncState; readonly cache: RowCache } {
  const input = { state: emptyState(LINEAGE, GENESIS, 0), content, cache: new Map(), implicit: implicitFor(ctx) };
  const res = captureFullPass(input, { kind: 'local', dot: dot(ctx.dev, ms), interactive: false }, ctx);
  return { state: res.state, cache: cacheFor(content) };
}

/**
 * What state-store's loader yields when the file's content changed after its sync tables
 * were written: head values of materialized rows (explicit, no `mat`) come from the current
 * content (`_life` reads 'live'), and are null, `_life` included, for vanished rows
 * (state-store-load.ts homeValue).
 */
export function simulateLoad(state: SyncState, content: ContentSnapshot, cache: RowCache): SyncState {
  const b = new StateBuilder(state);
  for (const [ks, row] of state.rows) {
    const values = contentValues(ks, row.key.tbl, row.key.rowId, content, cache);
    if (values === undefined) continue;
    for (const reg of row.regs.values()) {
      if (reg.mat) continue;
      const head = headOf(reg.key.reg, reg.sibs);
      if (!head) continue;
      const v = values.get(reg.key.reg) ?? null;
      b.setRegister({ ...reg, sibs: reg.sibs.map((s) => (s === head ? { ...s, value: v } : s)) });
    }
  }
  return b.build();
}

const VANISHED: ReadonlyMap<string, SyncValue> = new Map();

function contentValues(
  ks: string,
  tbl: number,
  rowId: string,
  content: ContentSnapshot,
  cache: RowCache,
): ReadonlyMap<string, SyncValue> | undefined {
  if (tbl === TBL.meta && rowId === META_ROW_ID) return readMetaRegisters(content.meta);
  if (cache.get(ks)?.materialized !== true) return undefined;
  const rows = tbl === TBL.entries ? content.entries : tbl === TBL.folders ? content.folders : content.history;
  const row = rows.get(rowId);
  return row ? readContentRow(tbl as 1 | 2 | 3, row).values : VANISHED;
}

/** Ciphertext of `plain` under an arbitrary key, in the vault format. */
export function sealWith(key: Buffer, plain: string): Buffer {
  return encrypt(Buffer.from(plain, 'utf8'), key);
}

/** Inserts a password_history row the way desktop's recordPasswordHistory does. */
export function addHistory(raw: Database.Database, id: string, entryId: string, key: Buffer, plain: string): void {
  raw
    .prepare('INSERT INTO password_history (id, entry_id, username, password_encrypted, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, entryId, 'old-user', sealWith(key, plain), '2026-09-20T10:00:00.000Z', 'user');
}

// ---------- Legacy writers ----------

export const SOURCE_SHA = 'ee'.repeat(32);
export const MTIME_MS = Date.parse('2026-09-25T11:00:00.000Z');

/** GRDB's default date text: 'YYYY-MM-DD HH:MM:SS.SSS' (UTC). */
export function grdb(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

export function legacyAtt(
  ctx: Pick<SyncContext, 'keys'>,
  overrides: Partial<LegacyAttribution> = {},
): LegacyAttribution {
  return {
    kind: 'legacy',
    observedMtimeMs: MTIME_MS,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    absorbKeys: ctx.keys.current,
    sourceSha256: SOURCE_SHA,
    ...overrides,
  };
}

/** Columns iOS 1.0.5's Entry model writes on save: every column except parent_entry_id. */
const IOS_ENTRY_COLUMNS = [
  'name', 'entry_type', 'folder_id', 'sort_order', 'host', 'port', 'credential_id', 'username',
  'password_encrypted', 'domain', 'private_key_encrypted', 'totp_secret_encrypted', 'icon', 'color',
  'credential_type', 'config', 'tags', 'is_favorite', 'notes', 'created_at', 'updated_at',
] as const;

const IOS_EMPTY_TEXT = ['host', 'username', 'domain'] as const;

/**
 * iOS 1.0.5 editor save: a whole-row UPDATE of the modeled columns (never parent_entry_id),
 * optional text written as '' instead of NULL, dates in GRDB format.
 */
export function iosSaveEntry(raw: Database.Database, id: string, patch: Partial<EntryRow>, updatedAtMs: number): void {
  const cur = raw.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow;
  const next: Record<string, unknown> = { ...cur, ...patch };
  for (const col of IOS_EMPTY_TEXT) if (next[col] === null) next[col] = '';
  next.created_at = grdb(Date.parse(String(cur.created_at)));
  next.updated_at = grdb(updatedAtMs);
  const sets = IOS_ENTRY_COLUMNS.map((c) => `${c} = @${c}`).join(', ');
  raw.prepare(`UPDATE entries SET ${sets} WHERE id = @id`).run(next);
}
