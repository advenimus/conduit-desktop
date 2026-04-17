/**
 * SQLite database operations for the unified .conduit vault.
 *
 * Uses better-sqlite3 with application-level encryption (not SQLCipher).
 * Sensitive fields (password, private_key) are encrypted via crypto.ts before storage.
 */

import Database from 'better-sqlite3';
import { CREATE_SCHEMA, SCHEMA_VERSION } from './schema.js';
import { MIGRATIONS } from './migrations.js';

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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.runMigrations();
  }

  private initSchema(): void {
    this.db.exec(CREATE_SCHEMA);

    // Set schema version if not present
    const ver = this.getMeta('schema_version');
    if (!ver) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
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
  deleteFolderRecursive(id: string): { foldersDeleted: number; entriesDeleted: number } {
    const collectDescendantIds = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      )
      SELECT id FROM descendants
    `);

    const deleteEntriesInFolders = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      )
      DELETE FROM entries WHERE folder_id IN (SELECT id FROM descendants)
    `);

    const deleteFoldersRecursive = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      )
      DELETE FROM folders WHERE id IN (SELECT id FROM descendants)
    `);

    let foldersDeleted = 0;
    let entriesDeleted = 0;

    const transaction = this.db.transaction(() => {
      // Collect descendant IDs before deletion (for return value)
      const folderIds = collectDescendantIds.all(id) as Array<{ id: string }>;
      // Delete entries first (FK references folders)
      const entryResult = deleteEntriesInFolders.run(id);
      entriesDeleted = entryResult.changes;
      // Delete all folders (target + descendants)
      const folderResult = deleteFoldersRecursive.run(id);
      foldersDeleted = folderResult.changes;
    });

    transaction();
    return { foldersDeleted, entriesDeleted };
  }

  // -- Entry CRUD --

  insertEntry(row: {
    id: string;
    name: string;
    entry_type: string;
    folder_id: string | null;
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
        `INSERT INTO entries (id, name, entry_type, folder_id, sort_order, host, port,
         credential_id, username, password_encrypted, domain, private_key_encrypted,
         totp_secret_encrypted, icon, color, config, tags, is_favorite, notes, credential_type, created_at, updated_at)
         VALUES (@id, @name, @entry_type, @folder_id, @sort_order, @host, @port,
         @credential_id, @username, @password_encrypted, @domain, @private_key_encrypted,
         @totp_secret_encrypted, @icon, @color, @config, @tags, @is_favorite, @notes, @credential_type, @created_at, @updated_at)`
      )
      .run({ ...row, credential_type: row.credential_type ?? null, totp_secret_encrypted: row.totp_secret_encrypted ?? null });
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
         sort_order = @sort_order, host = @host, port = @port, credential_id = @credential_id,
         username = @username, password_encrypted = @password_encrypted, domain = @domain,
         private_key_encrypted = @private_key_encrypted, totp_secret_encrypted = @totp_secret_encrypted,
         icon = @icon, color = @color, config = @config, tags = @tags,
         is_favorite = @is_favorite, notes = @notes, credential_type = @credential_type,
         updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ ...row, credential_type: row.credential_type ?? null, totp_secret_encrypted: row.totp_secret_encrypted ?? null });
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
