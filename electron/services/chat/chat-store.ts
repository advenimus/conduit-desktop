/**
 * Encrypted local chat storage.
 *
 * Persists AI conversations and messages in a SQLite database with
 * AES-256-GCM encryption on sensitive fields (titles, content, system prompts).
 *
 * Lifecycle is tied to the vault: initializes/unlocks with the master password,
 * locks when the vault locks.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { CREATE_CHAT_SCHEMA, CHAT_SCHEMA_VERSION } from './schema.js';

// ── Crypto constants ─────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;
const KEY_LEN = 32;
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Domain-separation context — prevents key reuse with the vault. */
const CHAT_KDF_CONTEXT = Buffer.from('conduit-chat-v1');

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersistedConversation {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  systemPrompt: string | null;
  isPinned: boolean;
  version: number;
  messageCount: number;
  engineSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  /** JSON-serialized ContentBlock[] */
  content: string;
  createdAt: string;
}

export interface PersistedEngineSession {
  id: string;
  engineType: string;
  externalId: string | null;
  model: string | null;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EngineSessionRow {
  id: string;
  engine_type: string;
  external_id: string | null;
  model: string | null;
  working_directory: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  title_encrypted: Buffer | null;
  provider: string;
  model: string;
  system_prompt_encrypted: Buffer | null;
  is_pinned: number;
  version: number;
  metadata: string;
  engine_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content_encrypted: Buffer;
  created_at: string;
}

// ── ChatStore ────────────────────────────────────────────────────────────────

export class ChatStore {
  private dbPath: string;
  private db: Database.Database | null = null;
  private encryptionKey: Buffer | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Get the path to the chat database file. */
  getDbPath(): string {
    return this.dbPath;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Create a new chat database with the given master password.
   * Generates a domain-separated salt and stores verification token.
   */
  initialize(masterPassword: string): void {
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const salt = crypto.randomBytes(SALT_LEN);
    const key = this.deriveKey(masterPassword, salt);

    try {
      const db = new Database(this.dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(CREATE_CHAT_SCHEMA);

      // Store salt
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('salt', salt.toString('base64'));
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('schema_version', String(CHAT_SCHEMA_VERSION));

      // Verification token
      const verification = this.encrypt(Buffer.from('conduit-chat-ok'), key);
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('verification', verification.toString('base64'));

      this.db = db;
      this.encryptionKey = key;
    } catch (err) {
      key.fill(0);
      throw err;
    }
  }

  /**
   * Unlock an existing chat database with the master password.
   */
  unlock(masterPassword: string): void {
    if (this.isUnlocked()) return;

    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Read salt
    const saltRow = db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('salt') as { value: string } | undefined;
    if (!saltRow) {
      db.close();
      throw new Error('Invalid chat database: no salt stored');
    }
    const salt = Buffer.from(saltRow.value, 'base64');
    const key = this.deriveKey(masterPassword, salt);

    // Verify
    const verRow = db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('verification') as { value: string } | undefined;
    if (!verRow) {
      key.fill(0);
      db.close();
      throw new Error('Invalid chat database: no verification token');
    }

    try {
      const decrypted = this.decrypt(Buffer.from(verRow.value, 'base64'), key);
      if (decrypted.toString('utf-8') !== 'conduit-chat-ok') {
        throw new Error('mismatch');
      }
    } catch {
      key.fill(0);
      db.close();
      throw new Error('Invalid master password for chat database');
    }

    // Run any pending schema migrations
    this.runMigrations(db);

    this.db = db;
    this.encryptionKey = key;
  }

  /**
   * Lock the chat store — zero the key and close the database.
   */
  lock(): void {
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
      this.encryptionKey = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Change the master password for the chat store.
   * Re-encrypts all encrypted fields (titles, system prompts, message content)
   * with a new key derived from the new password + fresh salt.
   *
   * Records that can't be decrypted with the current key (e.g. cloud-synced
   * conversations imported from another device with a different salt) are
   * deleted — they were already unreadable locally.
   */
  changePassword(currentPassword: string, newPassword: string): void {
    const { key: oldKey, db } = this.requireUnlocked();

    // Verify current password
    const saltRow = db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('salt') as { value: string } | undefined;
    if (!saltRow) throw new Error('Invalid chat database: no salt stored');
    const oldSalt = Buffer.from(saltRow.value, 'base64');
    const verifyKey = this.deriveKey(currentPassword, oldSalt);

    const verRow = db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('verification') as { value: string } | undefined;
    if (!verRow) throw new Error('Invalid chat database: no verification token');

    try {
      const decrypted = this.decrypt(Buffer.from(verRow.value, 'base64'), verifyKey);
      if (decrypted.toString('utf-8') !== 'conduit-chat-ok') throw new Error('mismatch');
    } catch {
      throw new Error('Current password is incorrect for chat database');
    }

    // Generate new salt and key
    const newSalt = crypto.randomBytes(SALT_LEN);
    const newKey = this.deriveKey(newPassword, newSalt);

    // Re-encrypt everything in a transaction
    const reEncryptTransaction = db.transaction(() => {
      // Re-encrypt conversations (title_encrypted, system_prompt_encrypted)
      // Records from cloud sync (different device/salt) may be undecryptable —
      // delete those conversations and their messages since they're unreadable anyway.
      const conversations = db.prepare('SELECT id, title_encrypted, system_prompt_encrypted FROM conversations').all() as {
        id: string;
        title_encrypted: Buffer | null;
        system_prompt_encrypted: Buffer | null;
      }[];

      const updateConv = db.prepare('UPDATE conversations SET title_encrypted = ?, system_prompt_encrypted = ? WHERE id = ?');
      const deleteConv = db.prepare('DELETE FROM conversations WHERE id = ?');
      const undecryptableConvIds: string[] = [];

      for (const conv of conversations) {
        let newTitle: Buffer | null = null;
        let newSystemPrompt: Buffer | null = null;
        let failed = false;

        if (conv.title_encrypted) {
          try {
            const plain = this.decrypt(conv.title_encrypted, oldKey);
            newTitle = this.encrypt(plain, newKey);
          } catch {
            failed = true;
          }
        }
        if (conv.system_prompt_encrypted && !failed) {
          try {
            const plain = this.decrypt(conv.system_prompt_encrypted, oldKey);
            newSystemPrompt = this.encrypt(plain, newKey);
          } catch {
            failed = true;
          }
        }

        if (failed) {
          // Cloud-synced opaque record — remove it (CASCADE deletes messages)
          undecryptableConvIds.push(conv.id);
          deleteConv.run(conv.id);
        } else if (conv.title_encrypted || conv.system_prompt_encrypted) {
          updateConv.run(newTitle, newSystemPrompt, conv.id);
        }
      }

      if (undecryptableConvIds.length > 0) {
        console.warn(`[chat-store] Removed ${undecryptableConvIds.length} undecryptable conversation(s) during password change`);
      }

      // Re-encrypt messages for remaining conversations
      const messages = db.prepare('SELECT id, content_encrypted FROM messages').all() as {
        id: string;
        content_encrypted: Buffer;
      }[];

      const updateMsg = db.prepare('UPDATE messages SET content_encrypted = ? WHERE id = ?');
      const deleteMsg = db.prepare('DELETE FROM messages WHERE id = ?');

      for (const msg of messages) {
        try {
          const plain = this.decrypt(msg.content_encrypted, oldKey);
          const newEnc = this.encrypt(plain, newKey);
          updateMsg.run(newEnc, msg.id);
        } catch {
          // Orphaned message with undecryptable content — remove it
          deleteMsg.run(msg.id);
        }
      }

      // Update salt and verification
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('salt', newSalt.toString('base64'));
      const newVerification = this.encrypt(Buffer.from('conduit-chat-ok'), newKey);
      db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('verification', newVerification.toString('base64'));
    });

    reEncryptTransaction();

    // Update in-memory key
    oldKey.fill(0);
    this.encryptionKey = newKey;
  }

  isUnlocked(): boolean {
    return this.encryptionKey !== null && this.db !== null;
  }

  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  // ── Conversation CRUD ──────────────────────────────────────────────────

  createConversation(input: {
    id: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    title?: string;
  }): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    const titleEnc = input.title ? this.encrypt(Buffer.from(input.title, 'utf-8'), key) : null;
    const promptEnc = input.systemPrompt ? this.encrypt(Buffer.from(input.systemPrompt, 'utf-8'), key) : null;

    db.prepare(`
      INSERT INTO conversations (id, title_encrypted, provider, model, system_prompt_encrypted, is_pinned, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(input.id, titleEnc, input.provider, input.model, promptEnc, now, now);
  }

  getConversation(id: string): PersistedConversation | null {
    const { key, db } = this.requireUnlocked();

    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!row) return null;

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(id) as { cnt: number };

    return this.rowToConversation(row, key, countRow.cnt);
  }

  listConversations(opts?: { limit?: number; offset?: number; search?: string }): PersistedConversation[] {
    const { key, db } = this.requireUnlocked();

    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    const rows = db.prepare(
      'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as ConversationRow[];

    // Batch-fetch message counts
    const ids = rows.map((r) => r.id);
    const counts = new Map<string, number>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const countRows = db.prepare(
        `SELECT conversation_id, COUNT(*) as cnt FROM messages WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`
      ).all(...ids) as { conversation_id: string; cnt: number }[];
      for (const cr of countRows) {
        counts.set(cr.conversation_id, cr.cnt);
      }
    }

    const result = rows.map((row) => this.rowToConversation(row, key, counts.get(row.id) ?? 0));

    // Client-side search filter (title is encrypted, must decrypt first)
    if (opts?.search) {
      const q = opts.search.toLowerCase();
      return result.filter((c) => c.title?.toLowerCase().includes(q));
    }

    return result;
  }

  updateConversation(id: string, input: { title?: string; isPinned?: boolean }): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    if (input.title !== undefined) {
      const titleEnc = this.encrypt(Buffer.from(input.title, 'utf-8'), key);
      db.prepare('UPDATE conversations SET title_encrypted = ?, updated_at = ? WHERE id = ?').run(titleEnc, now, id);
    }

    if (input.isPinned !== undefined) {
      db.prepare('UPDATE conversations SET is_pinned = ?, updated_at = ? WHERE id = ?').run(input.isPinned ? 1 : 0, now, id);
    }
  }

  deleteConversation(id: string): void {
    const { db } = this.requireUnlocked();
    // CASCADE deletes messages
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  countConversations(): number {
    const { db } = this.requireUnlocked();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM conversations').get() as { cnt: number };
    return row.cnt;
  }

  // ── Message CRUD ───────────────────────────────────────────────────────

  addMessage(conversationId: string, message: { id: string; role: string; content: string }): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    const contentEnc = this.encrypt(Buffer.from(message.content, 'utf-8'), key);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content_encrypted, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(message.id, conversationId, message.role, contentEnc, now);

    // Update conversation timestamp
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  }

  addMessages(conversationId: string, messages: { id: string; role: string; content: string }[]): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    const insert = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content_encrypted, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const batch = db.transaction(() => {
      for (const msg of messages) {
        const contentEnc = this.encrypt(Buffer.from(msg.content, 'utf-8'), key);
        insert.run(msg.id, conversationId, msg.role, contentEnc, now);
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    });

    batch();
  }

  getMessages(conversationId: string): PersistedMessage[] {
    const { key, db } = this.requireUnlocked();

    const rows = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as MessageRow[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as 'user' | 'assistant' | 'system',
      content: this.decrypt(row.content_encrypted, key).toString('utf-8'),
      createdAt: row.created_at,
    }));
  }

  countMessages(conversationId: string): number {
    const { db } = this.requireUnlocked();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversationId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Delete all messages beyond the first `keepCount` for a conversation.
   * Used by edit/retry to truncate conversation history from a given point.
   */
  deleteMessagesFrom(conversationId: string, keepCount: number): void {
    const { db } = this.requireUnlocked();
    const now = new Date().toISOString();

    if (keepCount <= 0) {
      // Delete all messages for this conversation
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    } else {
      // Get IDs of messages to keep (first N by created_at)
      const keepRows = db.prepare(
        'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
      ).all(conversationId, keepCount) as { id: string }[];

      if (keepRows.length > 0) {
        const keepIds = keepRows.map((r) => r.id);
        const placeholders = keepIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (${placeholders})`
        ).run(conversationId, ...keepIds);
      }
    }

    // Update conversation timestamp
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  }

  /**
   * Atomically replace all messages for a conversation.
   * Used after compaction to persist the summary + kept messages.
   */
  replaceAllMessages(conversationId: string, messages: { id: string; role: string; content: string }[]): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    const batch = db.transaction(() => {
      // Delete all existing messages
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
      // Insert new messages
      const insert = db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content_encrypted, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const msg of messages) {
        const contentEnc = this.encrypt(Buffer.from(msg.content, 'utf-8'), key);
        insert.run(msg.id, conversationId, msg.role, contentEnc, now);
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    });

    batch();
  }

  /**
   * Update the metadata JSON column for a conversation.
   */
  updateConversationMetadata(id: string, metadata: Record<string, unknown>): void {
    const { db } = this.requireUnlocked();
    const now = new Date().toISOString();
    const json = JSON.stringify(metadata);
    db.prepare('UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?').run(json, now, id);
  }

  /**
   * Read the metadata JSON for a conversation.
   */
  getConversationMetadata(id: string): Record<string, unknown> | null {
    const { db } = this.requireUnlocked();
    const row = db.prepare('SELECT metadata FROM conversations WHERE id = ?').get(id) as { metadata: string | null } | undefined;
    if (!row?.metadata) return null;
    try {
      return JSON.parse(row.metadata);
    } catch {
      return null;
    }
  }

  // ── Retention ──────────────────────────────────────────────────────────

  /**
   * Delete oldest non-pinned conversations to stay within the limit.
   * Returns the number of conversations deleted.
   */
  enforceRetentionLimit(maxConversations: number): number {
    if (maxConversations <= 0) return 0;
    const { db } = this.requireUnlocked();

    const total = this.countConversations();
    if (total <= maxConversations) return 0;

    const excess = total - maxConversations;

    // Get IDs of oldest non-pinned conversations to delete
    const toDelete = db.prepare(
      'SELECT id FROM conversations WHERE is_pinned = 0 ORDER BY updated_at ASC LIMIT ?'
    ).all(excess) as { id: string }[];

    if (toDelete.length === 0) return 0;

    const ids = toDelete.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  }

  // ── Cloud sync helpers ─────────────────────────────────────────────────

  /**
   * Serialize a conversation + messages for cloud sync.
   * Returns JSON with encrypted blobs as base64.
   */
  getConversationBlob(id: string): string | null {
    const { db } = this.requireUnlocked();

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!conv) return null;

    const messages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(id) as MessageRow[];

    // Serialize raw encrypted data as base64 for transport
    const blob = {
      conversation: {
        id: conv.id,
        title_encrypted: conv.title_encrypted?.toString('base64') ?? null,
        provider: conv.provider,
        model: conv.model,
        system_prompt_encrypted: conv.system_prompt_encrypted?.toString('base64') ?? null,
        is_pinned: conv.is_pinned,
        version: conv.version,
        engine_session_id: conv.engine_session_id ?? null,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content_encrypted: m.content_encrypted.toString('base64'),
        created_at: m.created_at,
      })),
    };

    return JSON.stringify(blob);
  }

  /**
   * Load a conversation from a cloud sync blob.
   * Replaces any existing conversation with the same ID.
   */
  loadConversationBlob(id: string, blobJson: string): void {
    const { db } = this.requireUnlocked();

    const blob = JSON.parse(blobJson);
    const conv = blob.conversation;
    const messages = blob.messages as { id: string; role: string; content_encrypted: string; created_at: string }[];

    // Validate blob structure
    if (!conv || typeof conv.id !== 'string') {
      throw new Error('Invalid blob: missing conversation data');
    }
    if (conv.id !== id) {
      throw new Error(`Blob conversation ID mismatch: expected ${id}, got ${conv.id}`);
    }
    if (!Array.isArray(messages)) {
      throw new Error('Invalid blob: messages is not an array');
    }
    const validRoles = new Set(['user', 'assistant', 'system']);
    for (const m of messages) {
      if (!validRoles.has(m.role)) {
        throw new Error(`Invalid message role in blob: ${m.role}`);
      }
    }

    const batch = db.transaction(() => {
      // Delete existing if present
      db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

      // Insert conversation
      db.prepare(`
        INSERT INTO conversations (id, title_encrypted, provider, model, system_prompt_encrypted, is_pinned, version, engine_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conv.id,
        conv.title_encrypted ? Buffer.from(conv.title_encrypted, 'base64') : null,
        conv.provider,
        conv.model,
        conv.system_prompt_encrypted ? Buffer.from(conv.system_prompt_encrypted, 'base64') : null,
        conv.is_pinned,
        conv.version,
        conv.engine_session_id ?? null,
        conv.created_at,
        conv.updated_at,
      );

      // Insert messages
      const insert = db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content_encrypted, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const m of messages) {
        insert.run(m.id, id, m.role, Buffer.from(m.content_encrypted, 'base64'), m.created_at);
      }
    });

    batch();
  }

  getConversationVersion(id: string): number {
    const { db } = this.requireUnlocked();
    const row = db.prepare('SELECT version FROM conversations WHERE id = ?').get(id) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  incrementVersion(id: string): number {
    const { db } = this.requireUnlocked();
    const now = new Date().toISOString();
    db.prepare('UPDATE conversations SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
    const row = db.prepare('SELECT version FROM conversations WHERE id = ?').get(id) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  /**
   * Clear all conversations and messages.
   */
  clearAll(): void {
    const { db } = this.requireUnlocked();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM conversations').run();
  }

  // ── Engine session CRUD ──────────────────────────────────────────────

  saveEngineSession(session: {
    id: string;
    engineType: string;
    externalId?: string;
    model?: string;
    workingDirectory?: string;
  }): void {
    const { db } = this.requireUnlocked();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO engine_sessions (id, engine_type, external_id, model, working_directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.engineType,
      session.externalId ?? null,
      session.model ?? null,
      session.workingDirectory ?? null,
      now,
      now,
    );
  }

  listEngineSessions(engineType?: string): PersistedEngineSession[] {
    const { db } = this.requireUnlocked();
    let rows: EngineSessionRow[];
    if (engineType) {
      rows = db.prepare(
        'SELECT * FROM engine_sessions WHERE engine_type = ? ORDER BY updated_at DESC'
      ).all(engineType) as EngineSessionRow[];
    } else {
      rows = db.prepare(
        'SELECT * FROM engine_sessions ORDER BY updated_at DESC'
      ).all() as EngineSessionRow[];
    }
    return rows.map((r) => ({
      id: r.id,
      engineType: r.engine_type,
      externalId: r.external_id,
      model: r.model,
      workingDirectory: r.working_directory,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getEngineSession(id: string): PersistedEngineSession | null {
    const { db } = this.requireUnlocked();
    const row = db.prepare('SELECT * FROM engine_sessions WHERE id = ?').get(id) as EngineSessionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      engineType: row.engine_type,
      externalId: row.external_id,
      model: row.model,
      workingDirectory: row.working_directory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteEngineSession(id: string): void {
    const { db } = this.requireUnlocked();
    db.prepare('DELETE FROM engine_sessions WHERE id = ?').run(id);
  }

  deleteAllEngineSessions(engineType?: string): void {
    const { db } = this.requireUnlocked();
    if (engineType) {
      db.prepare('DELETE FROM engine_sessions WHERE engine_type = ?').run(engineType);
    } else {
      db.prepare('DELETE FROM engine_sessions').run();
    }
  }

  // ── Engine conversation CRUD ─────────────────────────────────────────

  /**
   * Create a conversation linked to an engine session.
   * Engine messages store JSON.stringify(blocks) as the encrypted content.
   */
  createEngineConversation(input: {
    id: string;
    provider: string;       // 'claude-code' | 'codex'
    model: string;
    engineSessionId: string;
    title?: string;
  }): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();

    const titleEnc = input.title ? this.encrypt(Buffer.from(input.title, 'utf-8'), key) : null;

    db.prepare(`
      INSERT INTO conversations (id, title_encrypted, provider, model, system_prompt_encrypted, is_pinned, version, engine_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 0, 1, ?, ?, ?)
    `).run(input.id, titleEnc, input.provider, input.model, input.engineSessionId, now, now);
  }

  /**
   * Add an engine message to a conversation.
   * Blocks are serialized as JSON and encrypted into content_encrypted.
   */
  addEngineMessage(conversationId: string, msg: {
    id: string;
    role: string;
    blocks: unknown[];
    createdAt?: string;
  }): void {
    const { key, db } = this.requireUnlocked();
    const now = msg.createdAt ?? new Date().toISOString();

    const contentEnc = this.encrypt(Buffer.from(JSON.stringify(msg.blocks), 'utf-8'), key);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content_encrypted, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msg.id, conversationId, msg.role, contentEnc, now);

    // Update conversation timestamp
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  }

  /**
   * Get engine messages for a conversation.
   * Decrypts content and JSON.parses it back into blocks.
   */
  getEngineMessages(conversationId: string): Array<{
    id: string;
    role: string;
    blocks: unknown[];
    createdAt: string;
  }> {
    const { key, db } = this.requireUnlocked();

    const rows = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as MessageRow[];

    return rows.map((row) => {
      const raw = this.decrypt(row.content_encrypted, key).toString('utf-8');
      let blocks: unknown[];
      try {
        blocks = JSON.parse(raw);
      } catch {
        // Fallback: treat as plain text (for mixed conversations)
        blocks = [{ type: 'text', content: raw }];
      }
      return {
        id: row.id,
        role: row.role,
        blocks,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Find a conversation by its engine session ID.
   */
  findConversationByEngineSession(engineSessionId: string): PersistedConversation | null {
    const { key, db } = this.requireUnlocked();

    const row = db.prepare(
      'SELECT * FROM conversations WHERE engine_session_id = ? LIMIT 1'
    ).get(engineSessionId) as ConversationRow | undefined;
    if (!row) return null;

    const countRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?'
    ).get(row.id) as { cnt: number };

    return this.rowToConversation(row, key, countRow.cnt);
  }

  /**
   * Update the encrypted title for an engine conversation.
   */
  updateEngineConversationTitle(conversationId: string, title: string): void {
    const { key, db } = this.requireUnlocked();
    const now = new Date().toISOString();
    const titleEnc = this.encrypt(Buffer.from(title, 'utf-8'), key);
    db.prepare('UPDATE conversations SET title_encrypted = ?, updated_at = ? WHERE id = ?').run(titleEnc, now, conversationId);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private requireUnlocked(): { key: Buffer; db: Database.Database } {
    if (!this.encryptionKey || !this.db) {
      throw new Error('Chat store is locked');
    }
    return { key: this.encryptionKey, db: this.db };
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    const domainSalt = Buffer.concat([salt, CHAT_KDF_CONTEXT]);
    return crypto.pbkdf2Sync(password, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  }

  private encrypt(data: Buffer, key: Buffer): Buffer {
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ciphertext, tag]);
  }

  private decrypt(encrypted: Buffer, key: Buffer): Buffer {
    if (encrypted.length < NONCE_LEN + TAG_LEN) {
      throw new Error('Ciphertext too short');
    }
    const nonce = encrypted.subarray(0, NONCE_LEN);
    const tag = encrypted.subarray(encrypted.length - TAG_LEN);
    const ciphertext = encrypted.subarray(NONCE_LEN, encrypted.length - TAG_LEN);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private rowToConversation(row: ConversationRow, key: Buffer, messageCount: number): PersistedConversation {
    let title: string | null = null;
    if (row.title_encrypted) {
      try {
        title = this.decrypt(row.title_encrypted, key).toString('utf-8');
      } catch {
        title = '[encrypted]';
      }
    }

    let systemPrompt: string | null = null;
    if (row.system_prompt_encrypted) {
      try {
        systemPrompt = this.decrypt(row.system_prompt_encrypted, key).toString('utf-8');
      } catch {
        systemPrompt = null;
      }
    }

    return {
      id: row.id,
      title,
      provider: row.provider,
      model: row.model,
      systemPrompt,
      isPinned: row.is_pinned === 1,
      version: row.version,
      messageCount,
      engineSessionId: row.engine_session_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private runMigrations(db: Database.Database): void {
    const verRow = db.prepare('SELECT value FROM chat_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    const currentVersion = parseInt(verRow?.value ?? '1', 10);
    if (currentVersion >= CHAT_SCHEMA_VERSION) return;

    // v1 → v2: Add metadata column to conversations
    if (currentVersion < 2) {
      db.exec("ALTER TABLE conversations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
    }

    // v2 → v3: Add engine_sessions table
    if (currentVersion < 3) {
      db.exec(`
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
      `);
    }

    // v3 → v4: Add engine_session_id column to conversations
    if (currentVersion < 4) {
      db.exec("ALTER TABLE conversations ADD COLUMN engine_session_id TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_engine_session ON conversations(engine_session_id) WHERE engine_session_id IS NOT NULL");
    }

    db.prepare('INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)').run('schema_version', String(CHAT_SCHEMA_VERSION));
  }
}
