/**
 * SQLite database operations for the unified .conduit vault.
 *
 * Uses better-sqlite3 with application-level encryption (not SQLCipher).
 * Sensitive fields (password, private_key) are encrypted via crypto.ts before storage.
 */

import Database from 'better-sqlite3';
import { CREATE_SCHEMA, SCHEMA_VERSION } from './schema.js';
import { MIGRATIONS } from './migrations.js';
import { ensurePasswordHistory } from '../sync/schema.js';
import { markWalJournalMode } from './wal-header.js';

export interface ConduitDatabaseOptions {
  /** 'delete' for a working copy whose sync root is on a network path. Default 'wal'. */
  journalMode?: 'wal' | 'delete';
  /** false: the file must already exist. */
  create?: boolean;
}

/** What deleteFolderRecursive removed, collected before the delete (the FK cascades). */
export interface FolderDeleteResult {
  foldersDeleted: number;
  entriesDeleted: number;
  folderIds: string[];
  entryIds: string[];
  historyIds: string[];
}

const VACUUM_IN_TRANSACTION_MESSAGE = 'VACUUM INTO cannot run inside a transaction';

// -- Row types --

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryRow {
  id: string;
  name: string;
  entry_type: string;
  folder_id: string | null;
  parent_entry_id: string | null;
  sort_order: number;
  host: string | null;
  port: number | null;
  credential_id: string | null;
  username: string | null;
  password_encrypted: Buffer | null;
  domain: string | null;
  private_key_encrypted: Buffer | null;
  totp_secret_encrypted: Buffer | null;
  icon: string | null;
  color: string | null;
  config: string;
  tags: string;
  is_favorite: number;
  notes: string | null;
  credential_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface PasswordHistoryRow {
  id: string;
  entry_id: string;
  username: string | null;
  password_encrypted: Buffer | null;
  changed_at: string;
  changed_by: string | null;
}

// -- Database class --

export class ConduitDatabase {
  private db: Database.Database;

  constructor(dbPath: string, opts: ConduitDatabaseOptions = {}) {
    this.db = new Database(dbPath, opts.create === false ? { fileMustExist: true } : undefined);
    this.db.pragma(opts.journalMode === 'delete' ? 'journal_mode = DELETE' : 'journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    // Bootstrap vault_meta first so we can read schema_version before doing
    // anything else. CREATE_SCHEMA contains indexes on columns that may only
    // exist after migrations run, so the order matters: existing DBs must
    // migrate before CREATE_SCHEMA's index creation re-runs.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );

    const existingVersion = this.getMeta('schema_version');
    if (!existingVersion) {
      // Fresh DB — apply the full current schema in one shot and stamp version.
      this.db.exec(CREATE_SCHEMA);
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    } else {
      // Existing DB — run pending migrations first so any new columns exist
      // before CREATE_SCHEMA's idempotent CREATE INDEX statements run.
      this.runMigrations();
      this.db.exec(CREATE_SCHEMA);
    }
    // Fresh schema-10 files never got password_history (it lives in migration v3).
    ensurePasswordHistory(this.db);
  }

  /** The raw connection (a working copy's only connection, shared with the sync layer). */
  raw(): Database.Database {
    return this.db;
  }

  /** Writes a compact WAL-mode copy of this database to `target` (outside any transaction). */
  vacuumInto(target: string): void {
    if (this.db.inTransaction) throw new Error(VACUUM_IN_TRANSACTION_MESSAGE);
    this.db.prepare('VACUUM INTO ?').run(target);
    markWalJournalMode(target);
  }

  /**
   * Run pending migrations to bring the database up to SCHEMA_VERSION.
   * Each migration runs inside a transaction — if it fails, the transaction
   * rolls back and the error propagates (vault won't open).
   */
  private runMigrations(): void {
    const currentVersion = parseInt(this.getMeta('schema_version') ?? '1', 10);
    if (currentVersion >= SCHEMA_VERSION) return;

    const pending = MIGRATIONS
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      const runInTransaction = this.db.transaction(() => {
        migration.up(this.db);
        this.setMeta('schema_version', String(migration.version));
      });
      runInTransaction();
    }
  }

  // -- vault_meta helpers --

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // -- Folder CRUD --

  insertFolder(row: {
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
    icon: string | null;
    color: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO folders (id, name, parent_id, sort_order, icon, color, created_at, updated_at)
         VALUES (@id, @name, @parent_id, @sort_order, @icon, @color, @created_at, @updated_at)`
      )
      .run(row);
  }

  getFolder(id: string): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
  }

  listFolders(): FolderRow[] {
    return this.db
      .prepare('SELECT * FROM folders ORDER BY sort_order, name')
      .all() as FolderRow[];
  }

  updateFolder(row: {
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
    icon: string | null;
    color: string | null;
    updated_at: string;
  }): number {
    const result = this.db
      .prepare(
        `UPDATE folders SET name = @name, parent_id = @parent_id,
         sort_order = @sort_order, icon = @icon, color = @color, updated_at = @updated_at WHERE id = @id`
      )
      .run(row);
    return result.changes;
  }

  deleteFolder(id: string): number {
    const result = this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return result.changes;
  }

  /**
   * Recursively delete a folder and all its descendants (subfolders + entries).
   * Uses a CTE to collect all descendant folder IDs, then deletes entries and folders
   * in a single transaction.
   */
  deleteFolderRecursive(id: string): FolderDeleteResult {
    const collectDescendantIds = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      )
      SELECT id FROM descendants
    `);

    // Walk both folder hierarchy AND entry hierarchy: an entry rooted in this folder
    // (or nested under another entry that's rooted in this folder) is a descendant.
    const entryDescendantsCte = `
      WITH RECURSIVE
        folder_descendants(id) AS (
          SELECT id FROM folders WHERE id = ?
          UNION ALL
          SELECT f.id FROM folders f JOIN folder_descendants d ON f.parent_id = d.id
        ),
        entry_descendants(id) AS (
          SELECT id FROM entries WHERE folder_id IN (SELECT id FROM folder_descendants)
          UNION ALL
          SELECT e.id FROM entries e JOIN entry_descendants ed ON e.parent_entry_id = ed.id
        )`;
    const collectEntryIds = this.db.prepare(`${entryDescendantsCte} SELECT DISTINCT id FROM entry_descendants`);
    const collectHistoryIds = this.db.prepare(
      `${entryDescendantsCte} SELECT id FROM password_history WHERE entry_id IN (SELECT id FROM entry_descendants)`,
    );
    const deleteEntriesInFolders = this.db.prepare(
      `${entryDescendantsCte} DELETE FROM entries WHERE id IN (SELECT id FROM entry_descendants)`,
    );

    const deleteFoldersRecursive = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      )
      DELETE FROM folders WHERE id IN (SELECT id FROM descendants)
    `);

    const ids = (stmt: Database.Statement): string[] => (stmt.all(id) as Array<{ id: string }>).map((r) => r.id);

    const transaction = this.db.transaction((): FolderDeleteResult => {
      // Collect ids before deletion: password_history rows go with their entries (FK cascade).
      const folderIds = ids(collectDescendantIds);
      const entryIds = ids(collectEntryIds);
      const historyIds = ids(collectHistoryIds);
      // Delete entries first (FK references folders)
      const entriesDeleted = deleteEntriesInFolders.run(id).changes;
      // Delete all folders (target + descendants)
      const foldersDeleted = deleteFoldersRecursive.run(id).changes;
      return { foldersDeleted, entriesDeleted, folderIds, entryIds, historyIds };
    });

    return transaction();
  }

  // -- Entry CRUD --

  insertEntry(row: {
    id: string;
    name: string;
    entry_type: string;
    folder_id: string | null;
    parent_entry_id?: string | null;
    sort_order: number;
    host: string | null;
    port: number | null;
    credential_id: string | null;
    username: string | null;
    password_encrypted: Buffer | null;
    domain: string | null;
    private_key_encrypted: Buffer | null;
    totp_secret_encrypted?: Buffer | null;
    icon: string | null;
    color: string | null;
    config: string;
    tags: string;
    is_favorite: number;
    notes: string | null;
    credential_type?: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO entries (id, name, entry_type, folder_id, parent_entry_id, sort_order, host, port,
         credential_id, username, password_encrypted, domain, private_key_encrypted,
         totp_secret_encrypted, icon, color, config, tags, is_favorite, notes, credential_type, created_at, updated_at)
         VALUES (@id, @name, @entry_type, @folder_id, @parent_entry_id, @sort_order, @host, @port,
         @credential_id, @username, @password_encrypted, @domain, @private_key_encrypted,
         @totp_secret_encrypted, @icon, @color, @config, @tags, @is_favorite, @notes, @credential_type, @created_at, @updated_at)`
      )
      .run({
        ...row,
        parent_entry_id: row.parent_entry_id ?? null,
        credential_type: row.credential_type ?? null,
        totp_secret_encrypted: row.totp_secret_encrypted ?? null,
      });
  }

  getEntry(id: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
  }

  listEntries(): EntryRow[] {
    return this.db
      .prepare('SELECT * FROM entries ORDER BY sort_order, name')
      .all() as EntryRow[];
  }

  listEntriesByFolder(folderId: string | null): EntryRow[] {
    if (folderId === null) {
      return this.db
        .prepare('SELECT * FROM entries WHERE folder_id IS NULL ORDER BY sort_order, name')
        .all() as EntryRow[];
    }
    return this.db
      .prepare('SELECT * FROM entries WHERE folder_id = ? ORDER BY sort_order, name')
      .all(folderId) as EntryRow[];
  }

  listEntriesByType(entryType: string): EntryRow[] {
    return this.db
      .prepare('SELECT * FROM entries WHERE entry_type = ? ORDER BY sort_order, name')
      .all(entryType) as EntryRow[];
  }

  updateEntry(row: {
    id: string;
    name: string;
    entry_type: string;
    folder_id: string | null;
    parent_entry_id?: string | null;
    sort_order: number;
    host: string | null;
    port: number | null;
    credential_id: string | null;
    username: string | null;
    password_encrypted: Buffer | null;
    domain: string | null;
    private_key_encrypted: Buffer | null;
    totp_secret_encrypted?: Buffer | null;
    icon: string | null;
    color: string | null;
    config: string;
    tags: string;
    is_favorite: number;
    notes: string | null;
    credential_type?: string | null;
    updated_at: string;
  }): number {
    const result = this.db
      .prepare(
        `UPDATE entries SET name = @name, entry_type = @entry_type, folder_id = @folder_id,
         parent_entry_id = @parent_entry_id,
         sort_order = @sort_order, host = @host, port = @port, credential_id = @credential_id,
         username = @username, password_encrypted = @password_encrypted, domain = @domain,
         private_key_encrypted = @private_key_encrypted, totp_secret_encrypted = @totp_secret_encrypted,
         icon = @icon, color = @color, config = @config, tags = @tags,
         is_favorite = @is_favorite, notes = @notes, credential_type = @credential_type,
         updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        ...row,
        parent_entry_id: row.parent_entry_id ?? null,
        credential_type: row.credential_type ?? null,
        totp_secret_encrypted: row.totp_secret_encrypted ?? null,
      });
    return result.changes;
  }

  deleteEntry(id: string): number {
    const result = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    return result.changes;
  }

  /** Find credential-type entries in a folder (used for inheritance). */
  findCredentialsInFolder(folderId: string): EntryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entries WHERE folder_id = ? AND entry_type = 'credential'
         ORDER BY sort_order, name LIMIT 1`
      )
      .all(folderId) as EntryRow[];
  }

  /** Run a callback inside a SQLite transaction. */
  runInTransaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  // -- Password History CRUD --

  insertPasswordHistory(row: PasswordHistoryRow): void {
    this.db
      .prepare(
        `INSERT INTO password_history (id, entry_id, username, password_encrypted, changed_at, changed_by)
         VALUES (@id, @entry_id, @username, @password_encrypted, @changed_at, @changed_by)`
      )
      .run(row);
  }

  listPasswordHistory(entryId: string, limit?: number): PasswordHistoryRow[] {
    if (limit !== undefined) {
      return this.db
        .prepare('SELECT * FROM password_history WHERE entry_id = ? ORDER BY changed_at DESC LIMIT ?')
        .all(entryId, limit) as PasswordHistoryRow[];
    }
    return this.db
      .prepare('SELECT * FROM password_history WHERE entry_id = ? ORDER BY changed_at DESC')
      .all(entryId) as PasswordHistoryRow[];
  }

  getPasswordHistoryEntry(id: string): PasswordHistoryRow | undefined {
    return this.db.prepare('SELECT * FROM password_history WHERE id = ?').get(id) as PasswordHistoryRow | undefined;
  }

  deletePasswordHistory(id: string): number {
    const result = this.db.prepare('DELETE FROM password_history WHERE id = ?').run(id);
    return result.changes;
  }

  listAllPasswordHistory(): PasswordHistoryRow[] {
    return this.db.prepare('SELECT * FROM password_history').all() as PasswordHistoryRow[];
  }

  updatePasswordHistoryEncryption(id: string, passwordEncrypted: Buffer | null): void {
    this.db
      .prepare('UPDATE password_history SET password_encrypted = ? WHERE id = ?')
      .run(passwordEncrypted, id);
  }

  /** Force a WAL checkpoint — flushes all WAL data into the main database file. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}
