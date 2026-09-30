/**
 * Local connection history (docs/DASHBOARD.md 7.1): one SQLite file in the data dir, outside
 * every vault, so it is never synced, backed up or exported. Rows hold ids, protocol, times and
 * outcome only: no host names, entry names, user names, error text or credentials.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  HISTORY_MAX_ROWS_PER_VAULT,
  HISTORY_RETENTION_DAYS,
  type ConnectionHistoryEvent,
  type HistoryEndOutcome,
  type HistoryOutcome,
  type HistoryProtocol,
  type RecentConnection,
} from './dashboard-dto.js';

export const HISTORY_FILE_NAME = 'connection-history.db';
export const HISTORY_SCHEMA_VERSION = 1;
/** Pruning runs at open and after every this many inserts. */
export const PRUNE_EVERY_INSERTS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const SIDE_FILE_SUFFIXES = ['-wal', '-shm'] as const;
const OWNER_ONLY = 0o600;

function isDamagedFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB');
}

/** Keeps the damaged file and its WAL together so a new file never picks up the old WAL. */
function moveAside(filePath: string, now: Date): void {
  const aside = `${filePath}.damaged-${now.getTime()}`;
  for (const suffix of ['', ...SIDE_FILE_SUFFIXES]) {
    if (fs.existsSync(filePath + suffix)) fs.renameSync(filePath + suffix, aside + suffix);
  }
}

/** SQLite gives new WAL and SHM files the mode of the database file, so it is set first. */
function restrictToOwner(file: string, create: boolean): void {
  if (process.platform === 'win32') return;
  if (create) fs.closeSync(fs.openSync(file, 'a', OWNER_ONLY));
  else if (!fs.existsSync(file)) return;
  fs.chmodSync(file, OWNER_ONLY);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connection_history (
  id          TEXT PRIMARY KEY,
  vault_key   TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  protocol    TEXT NOT NULL CHECK (protocol IN ('ssh','rdp','vnc','web','command')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER,
  outcome     TEXT NOT NULL CHECK (outcome IN ('open','closed','dropped','failed','interrupted'))
);
CREATE INDEX IF NOT EXISTS idx_history_vault_started ON connection_history (vault_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_vault_entry ON connection_history (vault_key, entry_id, started_at DESC);
`;

interface HistoryRow {
  id: string;
  entry_id: string;
  protocol: HistoryProtocol;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  outcome: HistoryOutcome;
}

interface RecentRow extends HistoryRow {
  cnt: number;
}

export interface HistoryStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function toEvent(row: HistoryRow): ConnectionHistoryEvent {
  return {
    id: row.id,
    entryId: row.entry_id,
    protocol: row.protocol,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    outcome: row.outcome,
  };
}

function toRecent(row: RecentRow): RecentConnection {
  return {
    entryId: row.entry_id,
    protocol: row.protocol,
    lastStartedAt: row.started_at,
    lastEndedAt: row.ended_at,
    lastDurationMs: row.duration_ms,
    lastOutcome: row.outcome,
    count: row.cnt,
  };
}

export class ConnectionHistoryStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private insertsSincePrune = 0;

  private constructor(db: Database.Database, opts: HistoryStoreOptions) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Opens (or creates) the file, marks rows left open by a crash as interrupted, then prunes. A
   * damaged file is moved aside and a new one is created, since history is only a convenience.
   */
  static open(filePath: string, opts: HistoryStoreOptions = {}): ConnectionHistoryStore {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      return ConnectionHistoryStore.openFile(filePath, opts);
    } catch (err) {
      if (!isDamagedFileError(err)) throw err;
      console.warn('[dashboard] connection history file is damaged; starting a new one', { code: (err as { code: string }).code });
      moveAside(filePath, (opts.now ?? (() => new Date()))());
      return ConnectionHistoryStore.openFile(filePath, opts);
    }
  }

  private static openFile(filePath: string, opts: HistoryStoreOptions): ConnectionHistoryStore {
    restrictToOwner(filePath, true);
    const db = new Database(filePath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec(SCHEMA);
      if ((db.pragma('user_version', { simple: true }) as number) < HISTORY_SCHEMA_VERSION) {
        db.pragma(`user_version = ${HISTORY_SCHEMA_VERSION}`);
      }
      const store = new ConnectionHistoryStore(db, opts);
      store.interruptOpenRows();
      store.prune();
      for (const suffix of SIDE_FILE_SUFFIXES) restrictToOwner(filePath + suffix, false);
      return store;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  start(vaultKey: string, entryId: string, protocol: HistoryProtocol): string {
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO connection_history (id, vault_key, entry_id, protocol, started_at, outcome)
         VALUES (?, ?, ?, ?, ?, 'open')`,
      )
      .run(id, vaultKey, entryId, protocol, this.now().toISOString());
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= PRUNE_EVERY_INSERTS) this.prune();
    return id;
  }

  /** Only a row that is still open changes; unknown ids do nothing. */
  end(id: string, outcome: HistoryEndOutcome): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT started_at FROM connection_history WHERE id = ? AND outcome = 'open'`)
        .get(id) as { started_at: string } | undefined;
      if (row) this.finish(id, row.started_at, outcome);
    })();
  }

  /** One row per entry (its latest event) with its event count, newest first. */
  recent(vaultKey: string, limit: number): RecentConnection[] {
    const rows = this.db
      .prepare(
        `SELECT id, entry_id, protocol, started_at, ended_at, duration_ms, outcome, cnt FROM (
           SELECT *,
             ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY started_at DESC, rowid DESC) AS rn,
             COUNT(*) OVER (PARTITION BY entry_id) AS cnt
           FROM connection_history WHERE vault_key = ? AND started_at >= ?
         ) WHERE rn = 1 ORDER BY started_at DESC LIMIT ?`,
      )
      .all(vaultKey, this.retentionCutoff(), limit) as RecentRow[];
    return rows.map(toRecent);
  }

  forEntry(vaultKey: string, entryId: string, limit: number): ConnectionHistoryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, entry_id, protocol, started_at, ended_at, duration_ms, outcome FROM connection_history
         WHERE vault_key = ? AND entry_id = ? AND started_at >= ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(vaultKey, entryId, this.retentionCutoff(), limit) as HistoryRow[];
    return rows.map(toEvent);
  }

  clear(vaultKey: string): number {
    return this.db.prepare('DELETE FROM connection_history WHERE vault_key = ?').run(vaultKey).changes;
  }

  /** App quit: every open row ends now as closed. */
  closeOpenRows(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id, started_at FROM connection_history WHERE outcome = 'open'`)
        .all() as Array<{ id: string; started_at: string }>;
      for (const row of rows) this.finish(row.id, row.started_at, 'closed');
      return rows.length;
    })();
  }

  /** Deletes rows past the retention window, then keeps the newest rows of each vault key. */
  prune(): void {
    this.insertsSincePrune = 0;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM connection_history WHERE started_at < ?').run(this.retentionCutoff());
      this.db
        .prepare(
          `DELETE FROM connection_history WHERE rowid IN (
             SELECT rowid FROM (
               SELECT rowid, ROW_NUMBER() OVER (PARTITION BY vault_key ORDER BY started_at DESC, rowid DESC) AS rn
               FROM connection_history
             ) WHERE rn > ?
           )`,
        )
        .run(HISTORY_MAX_ROWS_PER_VAULT);
    })();
  }

  close(): void {
    this.db.close();
  }

  /** Rows left open by a crash or a renderer reload; the renderer can no longer end them. */
  interruptOpenRows(): number {
    return this.db.prepare(`UPDATE connection_history SET outcome = 'interrupted' WHERE outcome = 'open'`).run().changes;
  }

  private finish(id: string, startedAt: string, outcome: HistoryEndOutcome): void {
    const now = this.now();
    const started = Date.parse(startedAt);
    const duration = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null;
    this.db
      .prepare(
        `UPDATE connection_history SET ended_at = ?, duration_ms = ?, outcome = ? WHERE id = ? AND outcome = 'open'`,
      )
      .run(now.toISOString(), duration, outcome, id);
  }

  private retentionCutoff(): string {
    return new Date(this.now().getTime() - HISTORY_RETENTION_DAYS * DAY_MS).toISOString();
  }
}
