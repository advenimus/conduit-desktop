/**
 * Unified .conduit vault API.
 *
 * Manages a single portable .conduit SQLite file containing:
 * - Folders (hierarchical tree)
 * - Entries (connections + credentials in one table)
 * - Encrypted sensitive fields (password, private_key)
 * - Encryption verification token + salt in vault_meta
 */

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from './crypto.js';
import { ConduitDatabase, type EntryRow, type FolderRow, type PasswordHistoryRow } from './database.js';

// -- Public types --

export type EntryType = 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential' | 'document' | 'command';

export interface EntryMeta {
  id: string;
  name: string;
  entry_type: EntryType;
  folder_id: string | null;
  sort_order: number;
  host: string | null;
  port: number | null;
  credential_id: string | null;
  username: string | null;
  domain: string | null;
  icon: string | null;
  color: string | null;
  config: Record<string, unknown>;
  tags: string[];
  is_favorite: boolean;
  notes: string | null;
  credential_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryFull extends EntryMeta {
  password: string | null;
  private_key: string | null;
  totp_secret: string | null;
}

export interface FolderData {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolvedCredential {
  source: 'explicit' | 'inline' | 'inherited';
  source_entry_id: string | null;
  source_folder_id: string | null;
  username: string | null;
  password: string | null;
  domain: string | null;
  private_key: string | null;
}

export interface CreateEntryInput {
  name: string;
  entry_type: EntryType;
  folder_id?: string | null;
  host?: string | null;
  port?: number | null;
  credential_id?: string | null;
  username?: string | null;
  password?: string | null;
  domain?: string | null;
  private_key?: string | null;
  totp_secret?: string | null;
  icon?: string | null;
  color?: string | null;
  config?: Record<string, unknown>;
  tags?: string[];
  notes?: string | null;
  credential_type?: string | null;
}

export interface UpdateEntryInput {
  name?: string;
  entry_type?: EntryType;
  folder_id?: string | null;
  sort_order?: number;
  host?: string | null;
  port?: number | null;
  credential_id?: string | null;
  username?: string | null;
  password?: string | null;
  domain?: string | null;
  private_key?: string | null;
  totp_secret?: string | null;
  icon?: string | null;
  color?: string | null;
  config?: Record<string, unknown>;
  tags?: string[];
  is_favorite?: boolean;
  notes?: string | null;
  credential_type?: string | null;
}

export interface CreateFolderInput {
  name: string;
  parent_id?: string | null;
  icon?: string | null;
  color?: string | null;
}

export interface UpdateFolderInput {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
  icon?: string | null;
  color?: string | null;
}

// -- Vault class --

/** Describes a vault data mutation (for sync and audit). */
export interface VaultMutation {
  type: 'entry' | 'folder' | 'password_history';
  action: 'create' | 'update' | 'delete';
  id: string;
  name?: string;
}

export type MutationCallback = (mutation: VaultMutation) => void;

export class ConduitVault {
  private filePath: string;

  private encryptionKey: Buffer | null = null;
  private db: ConduitDatabase | null = null;
  private onMutationCallback: MutationCallback | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Register a callback that fires after any data-mutating operation. */
  setOnMutation(callback: MutationCallback | null): void {
    this.onMutationCallback = callback;
  }

  /** Notify listeners that vault data has changed. */
  private notifyMutation(mutation: VaultMutation): void {
    // Checkpoint WAL so changes are written to the main .conduit file.
    // This ensures iCloud Drive (and other file sync services) detect the change.
    this.db?.checkpoint();
    this.onMutationCallback?.(mutation);
  }

  /** Get the vault file path. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Check whether the vault file exists on disk. */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * Initialize a brand-new vault with the given master password.
   * Creates the .conduit file at the configured path.
   */
  initialize(masterPassword: string): void {
    if (this.exists()) {
      throw new Error('Vault file already exists');
    }

    // Ensure parent directory exists
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Generate salt and derive key
    const salt = crypto.generateSalt();
    const key = crypto.deriveKey(masterPassword, salt);

    // Open database and store salt + verification token inside SQLite
    const db = new ConduitDatabase(this.filePath);
    db.setMeta('salt', salt.toString('base64'));

    const verificationPlaintext = Buffer.from('conduit-vault-ok');
    const verificationEncrypted = crypto.encrypt(verificationPlaintext, key);
    db.setMeta('verification', verificationEncrypted.toString('base64'));

    this.encryptionKey = key;
    this.db = db;
  }

  /**
   * Unlock an existing vault with the master password.
   * Derives the key, verifies it, and opens the database.
   */
  unlock(masterPassword: string): void {
    if (!this.exists()) {
      throw new Error('Vault file not found');
    }
    if (this.isUnlocked()) {
      return;
    }

    // Open database to read salt
    const db = new ConduitDatabase(this.filePath);

    const keySource = db.getMeta('key_source');
    if (keySource === 'vek') {
      db.close();
      throw new Error('This vault uses key-based encryption. Use unlockWithKey() instead.');
    }

    const saltB64 = db.getMeta('salt');
    if (!saltB64) {
      db.close();
      throw new Error('Invalid vault: no salt stored');
    }
    const salt = Buffer.from(saltB64, 'base64');

    // Derive key
    const key = crypto.deriveKey(masterPassword, salt);

    // Verify
    const verificationB64 = db.getMeta('verification');
    if (!verificationB64) {
      db.close();
      throw new Error('Invalid vault: no verification token');
    }

    try {
      const verificationEncrypted = Buffer.from(verificationB64, 'base64');
      const decrypted = crypto.decrypt(verificationEncrypted, key);
      if (decrypted.toString('utf-8') !== 'conduit-vault-ok') {
        throw new Error('mismatch');
      }
    } catch {
      db.close();
      throw new Error('Invalid master password');
    }

    this.encryptionKey = key;
    this.db = db;
  }

  /** Lock the vault, clearing the encryption key and closing the database. */
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

  /** Force a WAL checkpoint so the .conduit file contains all data. */
  save(): void {
    if (!this.db) {
      throw new Error('Vault is not unlocked');
    }
    this.db.checkpoint();
  }

  /**
   * Reopen the database connection to pick up external file changes.
   *
   * When iCloud Drive replaces the vault file, the existing connection
   * may be stale. Opens a new connection first, then closes the old one
   * only on success. If the file is mid-sync (partially written), the
   * existing connection is kept.
   */
  reloadFromDisk(): void {
    if (!this.encryptionKey || !this.db) return;

    try {
      const newDb = new ConduitDatabase(this.filePath);
      const oldDb = this.db;
      this.db = newDb;
      try { oldDb.close(); } catch { /* ignore close errors */ }
    } catch (err) {
      // File may be mid-sync — keep existing connection, will retry next time
      console.warn('[vault] reloadFromDisk skipped (file may be syncing):', (err as Error).message);
    }
  }

  /** Check whether the vault is currently unlocked. */
  isUnlocked(): boolean {
    return this.encryptionKey !== null && this.db !== null;
  }

  // -- Folder operations --

  createFolder(input: CreateFolderInput): FolderData {
    const { db } = this.requireUnlocked();

    const id = uuidv4();
    const now = new Date().toISOString();
    const icon = input.icon ?? null;
    const color = input.color ?? null;

    db.insertFolder({
      id,
      name: input.name,
      parent_id: input.parent_id ?? null,
      sort_order: 0,
      icon,
      color,
      created_at: now,
      updated_at: now,
    });

    this.notifyMutation({ type: 'folder', action: 'create', id, name: input.name });
    return { id, name: input.name, parent_id: input.parent_id ?? null, sort_order: 0, icon, color, created_at: now, updated_at: now };
  }

  listFolders(): FolderData[] {
    const { db } = this.requireUnlocked();
    return db.listFolders().map(this.rowToFolder);
  }

  updateFolder(id: string, input: UpdateFolderInput): FolderData {
    const { db } = this.requireUnlocked();

    const existing = db.getFolder(id);
    if (!existing) {
      throw new Error(`Folder not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updated = {
      id,
      name: input.name ?? existing.name,
      parent_id: input.parent_id !== undefined ? input.parent_id : existing.parent_id,
      sort_order: input.sort_order ?? existing.sort_order,
      icon: input.icon !== undefined ? input.icon : existing.icon,
      color: input.color !== undefined ? input.color : existing.color,
      updated_at: now,
    };

    db.updateFolder(updated);
    this.notifyMutation({ type: 'folder', action: 'update', id, name: updated.name });
    return { ...updated, created_at: existing.created_at };
  }

  deleteFolder(id: string): void {
    const { db } = this.requireUnlocked();
    const existing = db.getFolder(id);
    const { foldersDeleted } = db.deleteFolderRecursive(id);
    if (foldersDeleted === 0) {
      throw new Error(`Folder not found: ${id}`);
    }
    this.notifyMutation({ type: 'folder', action: 'delete', id, name: existing?.name });
  }

  // -- Entry operations --

  createEntry(input: CreateEntryInput): EntryMeta {
    const { key, db } = this.requireUnlocked();

    const id = uuidv4();
    const now = new Date().toISOString();

    const passwordEnc = input.password
      ? crypto.encrypt(Buffer.from(input.password, 'utf-8'), key)
      : null;

    const privateKeyEnc = input.private_key
      ? crypto.encrypt(Buffer.from(input.private_key, 'utf-8'), key)
      : null;

    const totpSecretEnc = input.totp_secret
      ? crypto.encrypt(Buffer.from(input.totp_secret, 'utf-8'), key)
      : null;

    const tags = input.tags ?? [];
    const config = input.config ?? {};

    const icon = input.icon ?? null;
    const color = input.color ?? null;

    const credentialType = input.credential_type ?? null;

    db.insertEntry({
      id,
      name: input.name,
      entry_type: input.entry_type,
      folder_id: input.folder_id ?? null,
      sort_order: 0,
      host: input.host ?? null,
      port: input.port ?? null,
      credential_id: input.credential_id ?? null,
      username: input.username ?? null,
      password_encrypted: passwordEnc,
      domain: input.domain ?? null,
      private_key_encrypted: privateKeyEnc,
      totp_secret_encrypted: totpSecretEnc,
      icon,
      color,
      config: JSON.stringify(config),
      tags: JSON.stringify(tags),
      is_favorite: 0,
      notes: input.notes ?? null,
      credential_type: credentialType,
      created_at: now,
      updated_at: now,
    });

    this.notifyMutation({ type: 'entry', action: 'create', id, name: input.name });

    return {
      id,
      name: input.name,
      entry_type: input.entry_type,
      folder_id: input.folder_id ?? null,
      sort_order: 0,
      host: input.host ?? null,
      port: input.port ?? null,
      credential_id: input.credential_id ?? null,
      username: input.username ?? null,
      domain: input.domain ?? null,
      icon,
      color,
      config,
      tags,
      is_favorite: false,
      notes: input.notes ?? null,
      credential_type: credentialType,
      created_at: now,
      updated_at: now,
    };
  }

  /** Get an entry by ID with decrypted sensitive fields. */
  getEntry(id: string): EntryFull {
    const { key, db } = this.requireUnlocked();

    const row = db.getEntry(id);
    if (!row) {
      throw new Error(`Entry not found: ${id}`);
    }

    return this.rowToEntryFull(row, key);
  }

  /** Get entry metadata (no secrets). */
  getEntryMeta(id: string): EntryMeta {
    const { db } = this.requireUnlocked();

    const row = db.getEntry(id);
    if (!row) {
      throw new Error(`Entry not found: ${id}`);
    }

    return this.rowToEntryMeta(row);
  }

  /** List all entries (metadata only, no secrets). */
  listEntries(): EntryMeta[] {
    const { db } = this.requireUnlocked();
    return db.listEntries().map((row) => this.rowToEntryMeta(row));
  }

  /** Update an existing entry. */
  updateEntry(id: string, input: UpdateEntryInput): EntryMeta {
    const { key, db } = this.requireUnlocked();

    const existing = this.getEntry(id);
    const now = new Date().toISOString();

    const name = input.name ?? existing.name;
    const entryType = input.entry_type ?? existing.entry_type;
    const folderId = input.folder_id !== undefined ? input.folder_id : existing.folder_id;
    const sortOrder = input.sort_order ?? existing.sort_order;
    const host = input.host !== undefined ? input.host : existing.host;
    const port = input.port !== undefined ? input.port : existing.port;
    const credentialId = input.credential_id !== undefined ? input.credential_id : existing.credential_id;
    const username = input.username !== undefined ? input.username : existing.username;
    const password = input.password !== undefined ? input.password : existing.password;
    const domain = input.domain !== undefined ? input.domain : existing.domain;
    const privateKey = input.private_key !== undefined ? input.private_key : existing.private_key;
    const totpSecret = input.totp_secret !== undefined ? input.totp_secret : existing.totp_secret;
    const icon = input.icon !== undefined ? input.icon : existing.icon;
    const color = input.color !== undefined ? input.color : existing.color;
    const config = input.config ?? existing.config;
    const tags = input.tags ?? existing.tags;
    const isFavorite = input.is_favorite ?? existing.is_favorite;
    const credentialType = input.credential_type !== undefined ? input.credential_type : existing.credential_type;
    const notes = input.notes !== undefined ? input.notes : existing.notes;

    const passwordEnc = password
      ? crypto.encrypt(Buffer.from(password, 'utf-8'), key)
      : null;

    const privateKeyEnc = privateKey
      ? crypto.encrypt(Buffer.from(privateKey, 'utf-8'), key)
      : null;

    const totpSecretEnc = totpSecret
      ? crypto.encrypt(Buffer.from(totpSecret, 'utf-8'), key)
      : null;

    db.updateEntry({
      id,
      name,
      entry_type: entryType,
      folder_id: folderId,
      sort_order: sortOrder,
      host,
      port,
      credential_id: credentialId,
      username,
      password_encrypted: passwordEnc,
      domain,
      private_key_encrypted: privateKeyEnc,
      totp_secret_encrypted: totpSecretEnc,
      icon,
      color,
      config: JSON.stringify(config),
      tags: JSON.stringify(tags),
      is_favorite: isFavorite ? 1 : 0,
      notes,
      credential_type: credentialType,
      updated_at: now,
    });

    this.notifyMutation({ type: 'entry', action: 'update', id, name });

    return {
      id,
      name,
      entry_type: entryType as EntryType,
      folder_id: folderId,
      sort_order: sortOrder,
      host,
      port,
      credential_id: credentialId,
      username,
      domain,
      icon,
      color,
      config,
      tags,
      is_favorite: isFavorite,
      notes,
      credential_type: credentialType,
      created_at: existing.created_at,
      updated_at: now,
    };
  }

  /** Delete an entry by ID. */
  deleteEntry(id: string): void {
    const { db } = this.requireUnlocked();
    const existing = db.getEntry(id);
    const affected = db.deleteEntry(id);
    if (affected === 0) {
      throw new Error(`Entry not found: ${id}`);
    }
    this.notifyMutation({ type: 'entry', action: 'delete', id, name: existing?.name });
  }

  /** Move an entry to a different folder. */
  moveEntry(id: string, folderId: string | null): EntryMeta {
    return this.updateEntry(id, { folder_id: folderId });
  }

  /** Duplicate an entry, including encrypted secrets. Returns the new entry's metadata. */
  duplicateEntry(id: string): EntryMeta {
    const { key, db } = this.requireUnlocked();

    const row = db.getEntry(id);
    if (!row) {
      throw new Error(`Entry not found: ${id}`);
    }

    const newId = uuidv4();
    const now = new Date().toISOString();

    // Re-encrypt secrets with fresh IVs
    let passwordEnc: Buffer | null = null;
    if (row.password_encrypted) {
      const plaintext = crypto.decrypt(row.password_encrypted, key);
      passwordEnc = crypto.encrypt(plaintext, key);
    }

    let privateKeyEnc: Buffer | null = null;
    if (row.private_key_encrypted) {
      const plaintext = crypto.decrypt(row.private_key_encrypted, key);
      privateKeyEnc = crypto.encrypt(plaintext, key);
    }

    let totpSecretEnc: Buffer | null = null;
    if (row.totp_secret_encrypted) {
      const plaintext = crypto.decrypt(row.totp_secret_encrypted, key);
      totpSecretEnc = crypto.encrypt(plaintext, key);
    }

    const newName = `${row.name} (Copy)`;

    db.insertEntry({
      id: newId,
      name: newName,
      entry_type: row.entry_type,
      folder_id: row.folder_id,
      sort_order: 0,
      host: row.host,
      port: row.port,
      credential_id: row.credential_id,
      username: row.username,
      password_encrypted: passwordEnc,
      domain: row.domain,
      private_key_encrypted: privateKeyEnc,
      totp_secret_encrypted: totpSecretEnc,
      icon: row.icon,
      color: row.color,
      config: row.config,
      tags: row.tags,
      is_favorite: 0,
      notes: row.notes,
      credential_type: row.credential_type,
      created_at: now,
      updated_at: now,
    });

    this.notifyMutation({ type: 'entry', action: 'create', id: newId, name: newName });

    return this.rowToEntryMeta(db.getEntry(newId)!);
  }

  /**
   * Resolve the credential for a connection entry.
   *
   * Resolution order:
   * 1. Explicit credential_id -> use that credential entry
   * 2. Entry's own username/password -> use inline creds
   * 3. Walk UP folder tree -> find credential-type entries
   * 4. Return null if nothing found
   */
  resolveCredential(entryId: string): ResolvedCredential | null {
    const { key, db } = this.requireUnlocked();

    const entry = db.getEntry(entryId);
    if (!entry) {
      throw new Error(`Entry not found: ${entryId}`);
    }

    // 1. Explicit credential reference
    if (entry.credential_id) {
      const credRow = db.getEntry(entry.credential_id);
      if (credRow && credRow.entry_type === 'credential') {
        const full = this.rowToEntryFull(credRow, key);
        return {
          source: 'explicit',
          source_entry_id: credRow.id,
          source_folder_id: null,
          username: full.username,
          password: full.password,
          domain: full.domain,
          private_key: full.private_key,
        };
      }
    }

    // 2. Inline credentials on the entry itself
    if (entry.username || entry.password_encrypted || entry.private_key_encrypted) {
      const password = entry.password_encrypted
        ? crypto.decrypt(entry.password_encrypted, key).toString('utf-8')
        : null;
      const privateKey = entry.private_key_encrypted
        ? crypto.decrypt(entry.private_key_encrypted, key).toString('utf-8')
        : null;
      return {
        source: 'inline',
        source_entry_id: entry.id,
        source_folder_id: null,
        username: entry.username,
        password,
        domain: entry.domain,
        private_key: privateKey,
      };
    }

    // 3. Walk up folder tree
    let currentFolderId = entry.folder_id;
    while (currentFolderId) {
      const creds = db.findCredentialsInFolder(currentFolderId);
      if (creds.length > 0) {
        const credRow = creds[0];
        const full = this.rowToEntryFull(credRow, key);
        return {
          source: 'inherited',
          source_entry_id: credRow.id,
          source_folder_id: currentFolderId,
          username: full.username,
          password: full.password,
          domain: full.domain,
          private_key: full.private_key,
        };
      }
      // Move up to parent folder
      const folder = db.getFolder(currentFolderId);
      currentFolderId = folder?.parent_id ?? null;
    }

    // 4. Nothing found
    return null;
  }

  // -- Legacy compatibility: credential operations --
  // These wrap the entry API for backward compatibility with existing vault IPC and MCP

  /** List all credential-type entries (metadata only). */
  listCredentials(): { id: string; name: string; username: string | null; domain: string | null; tags: string[]; credential_type: string | null; created_at: string }[] {
    const { db } = this.requireUnlocked();
    return db.listEntriesByType('credential').map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      domain: row.domain,
      tags: row.tags ? JSON.parse(row.tags) : [],
      credential_type: row.credential_type ?? null,
      created_at: row.created_at,
    }));
  }

  /** Get a credential entry with decrypted secrets. */
  getCredential(id: string): { id: string; name: string; username: string | null; password: string | null; domain: string | null; private_key: string | null; totp_secret: string | null; tags: string[]; credential_type: string | null; public_key: string | null; fingerprint: string | null; totp_issuer: string | null; totp_label: string | null; totp_algorithm: string | null; totp_digits: number | null; totp_period: number | null; ssh_auth_method: string | null; created_at: string; updated_at: string } {
    const { key, db } = this.requireUnlocked();
    const row = db.getEntry(id);
    if (!row) throw new Error(`Credential not found: ${id}`);
    const full = this.rowToEntryFull(row, key);
    const config = full.config ?? {};
    return {
      id: full.id,
      name: full.name,
      username: full.username,
      password: full.password,
      domain: full.domain,
      private_key: full.private_key,
      totp_secret: full.totp_secret,
      tags: full.tags,
      credential_type: full.credential_type ?? null,
      public_key: (config.public_key as string) ?? null,
      fingerprint: (config.fingerprint as string) ?? null,
      totp_issuer: (config.totp_issuer as string) ?? null,
      totp_label: (config.totp_label as string) ?? null,
      totp_algorithm: (config.totp_algorithm as string) ?? null,
      totp_digits: (config.totp_digits as number) ?? null,
      totp_period: (config.totp_period as number) ?? null,
      ssh_auth_method: (config.ssh_auth_method as string) ?? null,
      created_at: full.created_at,
      updated_at: full.updated_at,
    };
  }

  /** Create a credential entry. */
  createCredential(input: { name: string; username?: string | null; password?: string | null; domain?: string | null; private_key?: string | null; totp_secret?: string | null; tags?: string[]; credential_type?: string | null; config?: Record<string, unknown> }): { id: string; name: string; username: string | null; password: string | null; domain: string | null; private_key: string | null; tags: string[]; credential_type: string | null; created_at: string; updated_at: string } {
    const meta = this.createEntry({
      name: input.name,
      entry_type: 'credential',
      username: input.username,
      password: input.password,
      domain: input.domain,
      private_key: input.private_key,
      totp_secret: input.totp_secret,
      tags: input.tags,
      credential_type: input.credential_type,
      config: input.config,
    });
    return {
      id: meta.id,
      name: meta.name,
      username: meta.username,
      password: input.password ?? null,
      domain: meta.domain,
      private_key: input.private_key ?? null,
      tags: meta.tags,
      credential_type: meta.credential_type ?? null,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
    };
  }

  /** Update a credential entry. */
  updateCredential(id: string, input: { name?: string; username?: string | null; password?: string | null; domain?: string | null; private_key?: string | null; totp_secret?: string | null; tags?: string[]; credential_type?: string | null; config?: Record<string, unknown> }): { id: string; name: string; username: string | null; password: string | null; domain: string | null; private_key: string | null; tags: string[]; credential_type: string | null; created_at: string; updated_at: string } {
    this.updateEntry(id, {
      ...input,
      credential_type: input.credential_type,
      config: input.config,
    });
    // Re-fetch to get decrypted values
    const full = this.getEntry(id);
    return {
      id: full.id,
      name: full.name,
      username: full.username,
      password: full.password,
      domain: full.domain,
      private_key: full.private_key,
      tags: full.tags,
      credential_type: full.credential_type ?? null,
      created_at: full.created_at,
      updated_at: full.updated_at,
    };
  }

  /** Delete a credential entry. */
  deleteCredential(id: string): void {
    this.deleteEntry(id);
  }

  // -- Password history --

  /** Record a password history entry. Encrypts the old password before storing. */
  recordPasswordHistory(entryId: string, oldUsername: string | null, oldPassword: string | null, changedBy: string | null): string {
    const { key, db } = this.requireUnlocked();

    const id = uuidv4();
    const now = new Date().toISOString();

    const passwordEncrypted = oldPassword
      ? crypto.encrypt(Buffer.from(oldPassword, 'utf-8'), key)
      : null;

    db.insertPasswordHistory({
      id,
      entry_id: entryId,
      username: oldUsername,
      password_encrypted: passwordEncrypted,
      changed_at: now,
      changed_by: changedBy,
    });

    this.notifyMutation({ type: 'password_history', action: 'create', id });
    return id;
  }

  /** List password history for an entry, decrypting passwords. */
  listPasswordHistory(entryId: string, limit?: number): Array<{ id: string; entry_id: string; username: string | null; password: string | null; changed_at: string; changed_by: string | null }> {
    const { key, db } = this.requireUnlocked();

    const rows = db.listPasswordHistory(entryId, limit);
    return rows.map((row) => ({
      id: row.id,
      entry_id: row.entry_id,
      username: row.username,
      password: row.password_encrypted
        ? crypto.decrypt(row.password_encrypted, key).toString('utf-8')
        : null,
      changed_at: row.changed_at,
      changed_by: row.changed_by,
    }));
  }

  /** Get a single password history entry, decrypted. */
  getPasswordHistoryEntry(id: string): { id: string; entry_id: string; username: string | null; password: string | null; changed_at: string; changed_by: string | null } | undefined {
    const { key, db } = this.requireUnlocked();

    const row = db.getPasswordHistoryEntry(id);
    if (!row) return undefined;

    return {
      id: row.id,
      entry_id: row.entry_id,
      username: row.username,
      password: row.password_encrypted
        ? crypto.decrypt(row.password_encrypted, key).toString('utf-8')
        : null,
      changed_at: row.changed_at,
      changed_by: row.changed_by,
    };
  }

  /** Delete a password history entry. */
  deletePasswordHistory(id: string): void {
    const { db } = this.requireUnlocked();
    const affected = db.deletePasswordHistory(id);
    if (affected === 0) {
      throw new Error(`Password history entry not found: ${id}`);
    }
    this.notifyMutation({ type: 'password_history', action: 'delete', id });
  }

  // -- Cloud sync metadata --

  /** Get or create a persistent UUID for this vault (stored in vault_meta). */
  getVaultId(): string {
    const { db } = this.requireUnlocked();
    let id = db.getMeta('vault_id');
    if (!id) {
      id = uuidv4();
      db.setMeta('vault_id', id);
    }
    return id;
  }

  /** Check if cloud sync is enabled in vault_meta. */
  isCloudSyncEnabled(): boolean {
    const { db } = this.requireUnlocked();
    return db.getMeta('cloud_sync_enabled') === 'true';
  }

  /** Set cloud sync enabled/disabled in vault_meta. */
  setCloudSyncEnabled(enabled: boolean): void {
    const { db } = this.requireUnlocked();
    db.setMeta('cloud_sync_enabled', enabled ? 'true' : 'false');
  }

  /** Check if chat cloud sync is enabled in vault_meta. */
  isChatCloudSyncEnabled(): boolean {
    const { db } = this.requireUnlocked();
    return db.getMeta('chat_cloud_sync_enabled') === 'true';
  }

  /** Set chat cloud sync enabled/disabled in vault_meta. */
  setChatCloudSyncEnabled(enabled: boolean): void {
    const { db } = this.requireUnlocked();
    db.setMeta('chat_cloud_sync_enabled', enabled ? 'true' : 'false');
  }

  // -- VEK-based operations (team vaults) --

  /**
   * Initialize a new vault with a VEK directly (no password).
   * Used for team vaults where the VEK is provided via key wrapping.
   * Stores key_source = 'vek' in vault_meta.
   */
  initializeWithKey(vek: Buffer): void {
    if (this.exists()) {
      throw new Error('Vault file already exists');
    }

    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const db = new ConduitDatabase(this.filePath);

    // Store verification token encrypted with VEK
    const verificationPlaintext = Buffer.from('conduit-vault-ok');
    const verificationEncrypted = crypto.encrypt(verificationPlaintext, vek);
    db.setMeta('verification', verificationEncrypted.toString('base64'));
    db.setMeta('key_source', 'vek');

    this.encryptionKey = Buffer.from(vek);
    this.db = db;
  }

  /**
   * Unlock an existing vault with a VEK directly (no password).
   * Verifies the VEK against the stored verification token.
   */
  unlockWithKey(vek: Buffer): void {
    if (!this.exists()) {
      throw new Error('Vault file not found');
    }
    if (this.isUnlocked()) {
      return;
    }

    const db = new ConduitDatabase(this.filePath);

    const verificationB64 = db.getMeta('verification');
    if (!verificationB64) {
      db.close();
      throw new Error('Invalid vault: no verification token');
    }

    try {
      const verificationEncrypted = Buffer.from(verificationB64, 'base64');
      const decrypted = crypto.decrypt(verificationEncrypted, vek);
      if (decrypted.toString('utf-8') !== 'conduit-vault-ok') {
        throw new Error('mismatch');
      }
    } catch {
      db.close();
      throw new Error('Invalid vault encryption key');
    }

    this.encryptionKey = Buffer.from(vek);
    this.db = db;
  }

  /**
   * Re-encrypt all sensitive fields with a new key.
   * Used for VEK rotation when team members are removed.
   * Transaction-wrapped: either all entries are re-encrypted or none.
   */
  rekey(newKey: Buffer): void {
    const { key: oldKey, db } = this.requireUnlocked();

    db.runInTransaction(() => {
      const entries = db.listEntries();

      for (const entry of entries) {
        let changed = false;
        let newPasswordEnc: Buffer | null = entry.password_encrypted;
        let newPrivateKeyEnc: Buffer | null = entry.private_key_encrypted;
        let newTotpSecretEnc: Buffer | null = entry.totp_secret_encrypted;

        if (entry.password_encrypted) {
          const plaintext = crypto.decrypt(entry.password_encrypted, oldKey);
          newPasswordEnc = crypto.encrypt(plaintext, newKey);
          changed = true;
        }

        if (entry.private_key_encrypted) {
          const plaintext = crypto.decrypt(entry.private_key_encrypted, oldKey);
          newPrivateKeyEnc = crypto.encrypt(plaintext, newKey);
          changed = true;
        }

        if (entry.totp_secret_encrypted) {
          const plaintext = crypto.decrypt(entry.totp_secret_encrypted, oldKey);
          newTotpSecretEnc = crypto.encrypt(plaintext, newKey);
          changed = true;
        }

        if (changed) {
          db.updateEntry({
            ...entry,
            password_encrypted: newPasswordEnc,
            private_key_encrypted: newPrivateKeyEnc,
            totp_secret_encrypted: newTotpSecretEnc,
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Re-encrypt password history
      const historyRows = db.listAllPasswordHistory();
      for (const row of historyRows) {
        if (row.password_encrypted) {
          const plaintext = crypto.decrypt(row.password_encrypted, oldKey);
          const newEnc = crypto.encrypt(plaintext, newKey);
          db.updatePasswordHistoryEncryption(row.id, newEnc);
        }
      }

      // Update verification token
      const verificationPlaintext = Buffer.from('conduit-vault-ok');
      const verificationEncrypted = crypto.encrypt(verificationPlaintext, newKey);
      db.setMeta('verification', verificationEncrypted.toString('base64'));

      // Mark as VEK-based
      if (db.getMeta('key_source') !== 'vek') {
        db.setMeta('key_source', 'vek');
      }
    });

    // Zero old key and set new key
    oldKey.fill(0);
    this.encryptionKey = Buffer.from(newKey);
  }

  /**
   * Change the master password for a password-based vault.
   * Verifies the current password, generates a new salt/key, re-encrypts all data,
   * and updates verification + salt metadata. Returns the new derived key.
   */
  changePassword(currentPassword: string, newPassword: string): Buffer {
    const { key: currentKey, db } = this.requireUnlocked();

    // Verify this is a password-based vault (not VEK/team)
    const keySource = db.getMeta('key_source');
    if (keySource === 'vek') {
      throw new Error('Cannot change password on a key-based (team) vault');
    }

    // Verify current password by deriving key and comparing verification
    const saltB64 = db.getMeta('salt');
    if (!saltB64) {
      throw new Error('Invalid vault: no salt stored');
    }
    const oldSalt = Buffer.from(saltB64, 'base64');
    const verifyKey = crypto.deriveKey(currentPassword, oldSalt);

    const verificationB64 = db.getMeta('verification');
    if (!verificationB64) {
      throw new Error('Invalid vault: no verification token');
    }

    try {
      const decrypted = crypto.decrypt(Buffer.from(verificationB64, 'base64'), verifyKey);
      if (decrypted.toString('utf-8') !== 'conduit-vault-ok') {
        throw new Error('mismatch');
      }
    } catch {
      throw new Error('Current password is incorrect');
    }

    // Generate new salt and derive new key
    const newSalt = crypto.generateSalt();
    const newKey = crypto.deriveKey(newPassword, newSalt);

    // Re-encrypt all entries using the existing rekey() logic
    this.rekey(newKey);

    // Update salt and restore key_source to 'password' (rekey sets it to 'vek')
    db.setMeta('salt', newSalt.toString('base64'));
    db.setMeta('key_source', 'password');

    return newKey;
  }

  /**
   * Read the key_source from vault_meta without fully unlocking.
   * Returns 'password' (default) or 'vek' (team vault).
   */
  peekKeySource(): 'password' | 'vek' {
    if (!this.exists()) {
      throw new Error('Vault file not found');
    }

    // If already unlocked, use the open DB
    if (this.db) {
      return (this.db.getMeta('key_source') as 'vek') ?? 'password';
    }

    // Open temporarily for read-only peek
    const db = new ConduitDatabase(this.filePath);
    try {
      return (db.getMeta('key_source') as 'vek') ?? 'password';
    } finally {
      db.close();
    }
  }

  /**
   * Read the team_vault_id from vault_meta without fully unlocking.
   * Returns null if not a team vault.
   */
  peekTeamVaultId(): string | null {
    if (!this.exists()) {
      throw new Error('Vault file not found');
    }

    if (this.db) {
      return this.db.getMeta('team_vault_id') ?? null;
    }

    const db = new ConduitDatabase(this.filePath);
    try {
      return db.getMeta('team_vault_id') ?? null;
    } finally {
      db.close();
    }
  }

  /**
   * Set the team vault ID in vault_meta.
   */
  setTeamVaultId(teamVaultId: string): void {
    const { db } = this.requireUnlocked();
    db.setMeta('team_vault_id', teamVaultId);
  }

  /**
   * Get raw access to the database for advanced operations (e.g., sync).
   * Only accessible while unlocked.
   */
  getDatabase(): ConduitDatabase {
    const { db } = this.requireUnlocked();
    return db;
  }

  /**
   * Get the current encryption key for sync operations.
   * Only accessible while unlocked. Caller must not store this reference.
   */
  getEncryptionKey(): Buffer {
    const { key } = this.requireUnlocked();
    return key;
  }

  // -- Internal helpers --

  private requireUnlocked(): { key: Buffer; db: ConduitDatabase } {
    if (!this.encryptionKey || !this.db) {
      throw new Error('Vault is locked');
    }

    return { key: this.encryptionKey, db: this.db };
  }

  private rowToFolder(row: FolderRow): FolderData {
    return {
      id: row.id,
      name: row.name,
      parent_id: row.parent_id,
      sort_order: row.sort_order,
      icon: row.icon ?? null,
      color: row.color ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private rowToEntryMeta(row: EntryRow): EntryMeta {
    return {
      id: row.id,
      name: row.name,
      entry_type: row.entry_type as EntryType,
      folder_id: row.folder_id,
      sort_order: row.sort_order,
      host: row.host,
      port: row.port,
      credential_id: row.credential_id,
      username: row.username,
      domain: row.domain,
      icon: row.icon ?? null,
      color: row.color ?? null,
      config: row.config ? JSON.parse(row.config) : {},
      tags: row.tags ? JSON.parse(row.tags) : [],
      is_favorite: row.is_favorite === 1,
      notes: row.notes,
      credential_type: row.credential_type ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private rowToEntryFull(row: EntryRow, key: Buffer): EntryFull {
    const password = row.password_encrypted
      ? crypto.decrypt(row.password_encrypted, key).toString('utf-8')
      : null;

    const privateKey = row.private_key_encrypted
      ? crypto.decrypt(row.private_key_encrypted, key).toString('utf-8')
      : null;

    const totpSecret = row.totp_secret_encrypted
      ? crypto.decrypt(row.totp_secret_encrypted, key).toString('utf-8')
      : null;

    return {
      ...this.rowToEntryMeta(row),
      password,
      private_key: privateKey,
      totp_secret: totpSecret,
    };
  }
}
