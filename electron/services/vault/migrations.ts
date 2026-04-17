/**
 * Forward-only sequential migrations for .conduit vault files.
 *
 * Each migration targets a specific schema version. On vault open,
 * the migration runner compares stored schema_version with the code's
 * SCHEMA_VERSION and runs all pending migrations in order.
 *
 * To add a new migration:
 * 1. Add an entry to MIGRATIONS with the next version number
 * 2. Bump SCHEMA_VERSION in schema.ts to match
 */

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

/**
 * Register migrations here as the schema evolves.
 * Each migration's `version` is the target version after running.
 *
 * Example:
 * {
 *   version: 2,
 *   description: 'Add color column to folders',
 *   up: (db) => {
 *     db.exec("ALTER TABLE folders ADD COLUMN color TEXT DEFAULT NULL");
 *   },
 * },
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'Add icon and color columns to entries and folders',
    up: (db) => {
      db.exec("ALTER TABLE entries ADD COLUMN icon TEXT DEFAULT NULL");
      db.exec("ALTER TABLE entries ADD COLUMN color TEXT DEFAULT NULL");
      db.exec("ALTER TABLE folders ADD COLUMN icon TEXT DEFAULT NULL");
      db.exec("ALTER TABLE folders ADD COLUMN color TEXT DEFAULT NULL");
    },
  },
  {
    version: 3,
    description: 'Add sync metadata and conflict tracking for team vaults',
    up: (db) => {
      // Track sync state per entity
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_sync_meta (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          cloud_version INTEGER NOT NULL DEFAULT 0,
          last_synced_at TEXT,
          PRIMARY KEY (entity_type, entity_id)
        )
      `);

      // Store conflicting local versions for 24h review
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_sync_conflicts (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          local_data TEXT NOT NULL,
          cloud_data TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 4,
    description: 'Add credential_type column to entries',
    up: (db) => {
      db.exec("ALTER TABLE entries ADD COLUMN credential_type TEXT DEFAULT NULL");
    },
  },
  {
    version: 5,
    description: 'Repair: ensure credential_type column exists (fixes databases created at v4 without it)',
    up: (db) => {
      // Check if the column already exists before attempting to add it
      const cols = db.pragma('table_info(entries)') as Array<{ name: string }>;
      const hasColumn = cols.some((c) => c.name === 'credential_type');
      if (!hasColumn) {
        db.exec("ALTER TABLE entries ADD COLUMN credential_type TEXT DEFAULT NULL");
      }
    },
  },
  {
    version: 6,
    description: 'Add document to entry_type CHECK constraint',
    up: (db) => {
      // SQLite requires table recreation to alter CHECK constraints
      db.exec(`
        CREATE TABLE entries_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('ssh','rdp','vnc','web','credential','document')),
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          host TEXT,
          port INTEGER,
          credential_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
          username TEXT,
          password_encrypted BLOB,
          domain TEXT,
          private_key_encrypted BLOB,
          icon TEXT DEFAULT NULL,
          color TEXT DEFAULT NULL,
          credential_type TEXT DEFAULT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          tags TEXT NOT NULL DEFAULT '[]',
          is_favorite INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO entries_new
        SELECT id, name, entry_type, folder_id, sort_order, host, port,
               credential_id, username, password_encrypted, domain,
               private_key_encrypted, icon, color, credential_type,
               config, tags, is_favorite, notes, created_at, updated_at
        FROM entries
      `);
      db.exec('DROP TABLE entries');
      db.exec('ALTER TABLE entries_new RENAME TO entries');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)');
    },
  },
  {
    version: 7,
    description: 'Add command to entry_type CHECK constraint',
    up: (db) => {
      db.exec(`
        CREATE TABLE entries_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('ssh','rdp','vnc','web','credential','document','command')),
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          host TEXT,
          port INTEGER,
          credential_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
          username TEXT,
          password_encrypted BLOB,
          domain TEXT,
          private_key_encrypted BLOB,
          icon TEXT DEFAULT NULL,
          color TEXT DEFAULT NULL,
          credential_type TEXT DEFAULT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          tags TEXT NOT NULL DEFAULT '[]',
          is_favorite INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO entries_new
        SELECT id, name, entry_type, folder_id, sort_order, host, port,
               credential_id, username, password_encrypted, domain,
               private_key_encrypted, icon, color, credential_type,
               config, tags, is_favorite, notes, created_at, updated_at
        FROM entries
      `);
      db.exec('DROP TABLE entries');
      db.exec('ALTER TABLE entries_new RENAME TO entries');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)');
    },
  },
  {
    version: 8,
    description: 'Add totp_secret_encrypted column to entries',
    up: (db) => {
      db.exec("ALTER TABLE entries ADD COLUMN totp_secret_encrypted BLOB DEFAULT NULL");
    },
  },
  {
    version: 9,
    description: 'Add password_history table',
    up: (db) => {
      db.exec(`
        CREATE TABLE password_history (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          username TEXT,
          password_encrypted BLOB,
          changed_at TEXT NOT NULL,
          changed_by TEXT
        )
      `);
      db.exec('CREATE INDEX idx_password_history_entry ON password_history(entry_id, changed_at DESC)');
    },
  },
];
