/**
 * Classifying a staged copy of S (spec 5.2, 5.12): header checks on the raw bytes, then the
 * private staged file opened read-write (a WAL-mode header from an older in-place writer opens
 * fine and its -wal/-shm, if any, appear in incoming/, never next to S), quick_check,
 * sync_format, table presence and the sync state. Also the torn-file retry schedule.
 * Import through shared-file.ts.
 */

import Database from 'better-sqlite3';
import type { FileKeyMeta } from './key-epoch.js';
import { hasContentTables, hasSyncTables, readSyncFormat } from './schema.js';
import {
  SQLITE_MAGIC,
  TORN_QUARANTINE_AFTER_MS,
  TORN_RETRY_DELAYS_MS,
  type ClassifyExpectation,
  type SharedClass,
  type SharedSnapshot,
  type TornVerdict,
  type UnreadableReason,
} from './shared-file-types.js';
import { loadContent, loadFile } from './state-store.js';
import { SYNC_FORMAT, SyncCoreError } from './types.js';

const HEADER_LEN = 100;
const MAGIC_LEN = 16;
const OFF_PAGE_SIZE = 16;
const OFF_CHANGE_COUNTER = 24;
const OFF_PAGE_COUNT = 28;
const OFF_VERSION_VALID_FOR = 92;
/** Page size field value 1 means 65536 (SQLite file format 1.3.2). */
const PAGE_SIZE_65536_MARKER = 1;
const MIN_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 65_536;
const QUICK_CHECK_OK = 'ok';
const META_SALT = 'salt';
const META_VERIFICATION = 'verification';

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function pageSizeOf(bytes: Buffer): number | null {
  const raw = bytes.readUInt16BE(OFF_PAGE_SIZE);
  const size = raw === PAGE_SIZE_65536_MARKER ? MAX_PAGE_SIZE : raw;
  return isPowerOfTwo(size) && size >= MIN_PAGE_SIZE && size <= MAX_PAGE_SIZE ? size : null;
}

/** 5.2 header checks on raw bytes: magic, page size, header page count vs size. null = passes. */
export function checkHeader(bytes: Buffer): UnreadableReason | null {
  if (bytes.length < MAGIC_LEN || bytes.subarray(0, MAGIC_LEN).toString('latin1') !== SQLITE_MAGIC) return 'magic';
  if (bytes.length < HEADER_LEN) return 'page-size';
  const pageSize = pageSizeOf(bytes);
  if (pageSize === null || bytes.length % pageSize !== 0) return 'page-size';
  const headerPages = bytes.readUInt32BE(OFF_PAGE_COUNT);
  const headerValid = bytes.readUInt32BE(OFF_VERSION_VALID_FOR) === bytes.readUInt32BE(OFF_CHANGE_COUNTER);
  if (headerPages !== 0 && headerValid && headerPages !== bytes.length / pageSize) return 'page-count';
  return null;
}

function unreadable(reason: UnreadableReason): SharedClass {
  return { kind: 'unreadable', reason };
}

function readKeyMeta(db: Database.Database): FileKeyMeta {
  const rows = db
    .prepare('SELECT key, value FROM vault_meta WHERE key IN (?, ?)')
    .all(META_SALT, META_VERIFICATION) as Array<{ key: string; value: unknown }>;
  const text = (k: string): string | null => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === 'string' && v !== '' ? v : null;
  };
  return { salt: text(META_SALT), verification: text(META_VERIFICATION) };
}

function quickCheckPasses(db: Database.Database): boolean {
  const result = db.pragma('quick_check', { simple: true });
  return result === QUICK_CHECK_OK;
}

/** Everything after quick_check; SQLite read errors here mean the file is damaged. */
function classifyOpen(db: Database.Database, expect: ClassifyExpectation): SharedClass {
  const syncFormat = readSyncFormat(db);
  if (syncFormat !== null && syncFormat > SYNC_FORMAT) return { kind: 'foreign-newer', syncFormat };
  if (!hasContentTables(db)) return { kind: 'foreign-other', lineageId: null, reason: 'not-conduit' };
  const meta = readKeyMeta(db);
  if (meta.salt === null && meta.verification === null) {
    return { kind: 'foreign-other', lineageId: null, reason: 'not-conduit' };
  }
  if (syncFormat === null) return { kind: 'presync', content: loadContent(db), meta };
  if (!hasSyncTables(db)) return unreadable('missing-tables');
  const file = loadFile(db);
  const lineageId = file.state.lineageId;
  if (expect.lineageId !== null && lineageId !== expect.lineageId) {
    return { kind: 'foreign-other', lineageId, reason: 'lineage' };
  }
  return { kind: 'synced', file, meta };
}

function reasonForReadError(err: unknown): UnreadableReason {
  if (err instanceof SyncCoreError) {
    if (err.code === 'CORRUPT_STATE') return 'corrupt-sync-state';
    if (err.code === 'UNSUPPORTED_FORMAT') return 'missing-tables';
    throw err;
  }
  if (err instanceof Database.SqliteError) return 'quick-check';
  throw err;
}

/**
 * Classifies a staged copy (5.2 table). Opens the staged file read-write (it is our private
 * copy, so a WAL-mode header can be opened), runs PRAGMA quick_check, schema.readSyncFormat,
 * hasSyncTables/hasContentTables, and state-store.loadFile or loadContent. A SyncCoreError
 * CORRUPT_STATE from loadFile is 'unreadable' ('corrupt-sync-state'). Closes the connection.
 */
export function classifyStaged(snapshot: SharedSnapshot, expect: ClassifyExpectation): SharedClass {
  const header = checkHeader(snapshot.bytes);
  if (header !== null) return unreadable(header);
  let db: Database.Database;
  try {
    db = new Database(snapshot.stagedPath, { fileMustExist: true });
  } catch (err) {
    if (err instanceof Database.SqliteError || err instanceof TypeError) return unreadable('open-failed');
    throw err;
  }
  try {
    let passes: boolean;
    try {
      passes = quickCheckPasses(db);
    } catch (err) {
      if (err instanceof Database.SqliteError) return unreadable('open-failed');
      throw err;
    }
    if (!passes) return unreadable('quick-check');
    try {
      return classifyOpen(db, expect);
    } catch (err) {
      return unreadable(reasonForReadError(err));
    }
  } finally {
    db.close();
  }
}

/** 5.2 torn rule: retries at TORN_RETRY_DELAYS_MS after first sight, quarantine after 2 min of the same bytes. */
export class TornTracker {
  private sha: string | null = null;
  private firstSeenMs = 0;
  private quarantinedSha: string | null = null;

  /** Record an unreadable observation of `sha256` at nowMs. New bytes restart the schedule. */
  observe(sha256: string, nowMs: number): TornVerdict {
    if (sha256 !== this.sha) {
      this.sha = sha256;
      this.firstSeenMs = nowMs;
    }
    if (sha256 === this.quarantinedSha) return { kind: 'republish' };
    const t0 = this.firstSeenMs;
    if (nowMs >= t0 + TORN_QUARANTINE_AFTER_MS) return { kind: 'quarantine' };
    for (const delay of TORN_RETRY_DELAYS_MS) {
      if (nowMs < t0 + delay) return { kind: 'retry', atMs: t0 + delay };
    }
    return { kind: 'retry', atMs: t0 + TORN_QUARANTINE_AFTER_MS };
  }

  /** The copy of `sha256` is in quarantine/: later observations of these bytes only republish. */
  quarantined(sha256: string): void {
    this.quarantinedSha = sha256;
  }

  /** S became readable (or missing): forget the observation. */
  reset(): void {
    this.sha = null;
    this.firstSeenMs = 0;
    this.quarantinedSha = null;
  }
}
