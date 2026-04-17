/**
 * SQLite schema for the encrypted chat history database.
 *
 * Stored as a separate file: {userData}/conduit/conduit-chat.db
 * Sensitive fields (title, content, system_prompt) are encrypted with
 * AES-256-GCM using a key derived via PBKDF2 with domain context
 * 'conduit-chat-v1' to prevent key reuse with the vault.
 */

export const CHAT_SCHEMA_VERSION = 4;

export const CREATE_CHAT_SCHEMA = `
  -- Metadata (encryption verification, salt, schema version)
  CREATE TABLE IF NOT EXISTS chat_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Conversations
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title_encrypted BLOB,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt_encrypted BLOB,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    metadata TEXT NOT NULL DEFAULT '{}',
    engine_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Messages
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content_encrypted BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC);

  -- Engine sessions (SDK-based AI engine session metadata)
  CREATE TABLE IF NOT EXISTS engine_sessions (
    id TEXT PRIMARY KEY,
    engine_type TEXT NOT NULL,
    external_id TEXT,
    model TEXT,
    working_directory TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_engine_sessions_type
    ON engine_sessions(engine_type, updated_at DESC);
`;
