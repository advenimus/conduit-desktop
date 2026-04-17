/**
 * SQLite schema for the unified .conduit vault file.
 *
 * Replaces the split connections.json + vault.db architecture with a single
 * portable SQLite file containing entries, folders, and encrypted credentials.
 */

export const SCHEMA_VERSION = 9;

export const CREATE_SCHEMA = `
  -- Metadata (encryption verification, schema version, salt)
  CREATE TABLE IF NOT EXISTS vault_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Folders (self-referential tree)
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    icon TEXT DEFAULT NULL,
    color TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Unified entries: connections + credentials in one table
  CREATE TABLE IF NOT EXISTS entries (
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
    totp_secret_encrypted BLOB,
    icon TEXT DEFAULT NULL,
    color TEXT DEFAULT NULL,
    credential_type TEXT DEFAULT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name);
  CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
  CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id);
  CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
`;
