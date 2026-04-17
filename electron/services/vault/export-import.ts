/**
 * Vault export/import service.
 *
 * Exports vault data (folders + entries with decrypted secrets) to an
 * encrypted `.conduit-export` file, and imports from such files into
 * any vault (personal or team).
 *
 * File format: [version(1 byte=0x01) | salt(32) | nonce(12) | encrypted_json | auth_tag(16)]
 *
 * The JSON payload is encrypted with AES-256-GCM using a key derived
 * from a user-provided passphrase via PBKDF2-SHA256 (600k iterations),
 * domain-separated with 'conduit-export-v1'.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ConduitVault, EntryFull, FolderData } from './vault.js';

// ── Constants ──────────────────────────────────────────────────────

const VERSION = 0x01;
const PBKDF2_ITERATIONS = 600_000;
const KEY_LEN = 32;
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MIN_BLOB_SIZE = 1 + SALT_LEN + NONCE_LEN + TAG_LEN;
const MAX_EXPORT_SIZE = 100 * 1024 * 1024; // 100 MB
const EXPORT_KDF_CONTEXT = Buffer.from('conduit-export-v1');
const VALID_ENTRY_TYPES = new Set(['ssh', 'rdp', 'vnc', 'web', 'credential', 'document']);

// ── Types ──────────────────────────────────────────────────────────

export interface ExportFolder {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportEntry {
  id: string;
  name: string;
  entry_type: string;
  folder_id: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  private_key: string | null;
  domain: string | null;
  credential_id: string | null;
  config: Record<string, unknown>;
  tags: string[];
  notes: string | null;
  credential_type: string | null;
  sort_order: number;
  icon: string | null;
  color: string | null;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExportPayload {
  format_version: 1;
  exported_at: string;
  source_vault_name: string;
  scope: 'full' | 'folder';
  scope_path: string | null;
  folders: ExportFolder[];
  entries: ExportEntry[];
}

export interface ExportOptions {
  scope: 'full' | 'folder';
  folderIds?: string[];
  passphrase: string;
  outputPath: string;
}

export interface ImportPreview {
  source_vault_name: string;
  exported_at: string;
  scope: string;
  scope_path: string | null;
  folder_count: number;
  entry_count: number;
  entry_type_counts: Record<string, number>;
  folder_tree: Array<{ id: string; name: string; parent_id: string | null }>;
}

export interface ImportOptions {
  // Reserved for future use
}

export interface ImportResult {
  foldersCreated: number;
  entriesCreated: number;
  credentialRefsRemapped: number;
  credentialRefsCleared: number;
}

// ── Crypto helpers ─────────────────────────────────────────────────

function deriveExportKey(passphrase: string, salt: Buffer): Buffer {
  const domainSalt = Buffer.concat([salt, EXPORT_KDF_CONTEXT]);
  return crypto.pbkdf2Sync(passphrase, domainSalt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

function encryptPayload(json: string, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = deriveExportKey(passphrase, salt);

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([
      Buffer.from([VERSION]),
      salt,
      nonce,
      ciphertext,
      tag,
    ]);
  } finally {
    key.fill(0);
  }
}

function decryptPayload(blob: Buffer, passphrase: string): string {
  if (blob.length < MIN_BLOB_SIZE) {
    throw new Error('Export file is too short or corrupted');
  }

  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`Unsupported export format version: ${version}`);
  }

  let offset = 1;
  const salt = blob.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;

  const nonce = blob.subarray(offset, offset + NONCE_LEN);
  offset += NONCE_LEN;

  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(offset, blob.length - TAG_LEN);

  const key = deriveExportKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
    } catch {
      throw new Error('Incorrect passphrase — please check and try again.');
    }
  } finally {
    key.fill(0);
  }
}

// ── Export ──────────────────────────────────────────────────────────

/**
 * Export vault data to an encrypted .conduit-export file.
 */
export function exportVault(vault: ConduitVault, options: ExportOptions): { folderCount: number; entryCount: number } {
  if (!vault.isUnlocked()) {
    throw new Error('Vault must be unlocked to export');
  }

  const allFolders = vault.listFolders();
  const allEntries = vault.listEntries();

  let scopeFolders: FolderData[];
  let scopeEntryIds: Set<string>;
  let scopePath: string | null = null;

  if (options.scope === 'folder' && options.folderIds && options.folderIds.length > 0) {
    // Collect all selected folders and their descendants
    const folderIdSet = new Set<string>();
    const queue: string[] = [];

    for (const fid of options.folderIds) {
      folderIdSet.add(fid);
      queue.push(fid);
    }

    // BFS to find all descendant folders
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const f of allFolders) {
        if (f.parent_id === parentId && !folderIdSet.has(f.id)) {
          folderIdSet.add(f.id);
          queue.push(f.id);
        }
      }
    }

    scopeFolders = allFolders.filter(f => folderIdSet.has(f.id));

    // Collect entries in those folders
    scopeEntryIds = new Set(
      allEntries.filter(e => e.folder_id && folderIdSet.has(e.folder_id)).map(e => e.id)
    );

    // Build scope_path from the selected folder names
    const selectedNames = options.folderIds
      .map(id => allFolders.find(f => f.id === id)?.name)
      .filter(Boolean);
    scopePath = selectedNames.join(', ');
  } else {
    scopeFolders = allFolders;
    scopeEntryIds = new Set(allEntries.map(e => e.id));
  }

  // Get full entry data (with decrypted secrets)
  const exportEntries: ExportEntry[] = [];
  for (const meta of allEntries) {
    if (!scopeEntryIds.has(meta.id)) continue;
    const full: EntryFull = vault.getEntry(meta.id);
    exportEntries.push({
      id: full.id,
      name: full.name,
      entry_type: full.entry_type,
      folder_id: full.folder_id,
      host: full.host,
      port: full.port,
      username: full.username,
      password: full.password,
      private_key: full.private_key,
      domain: full.domain,
      credential_id: full.credential_id,
      config: full.config,
      tags: full.tags,
      notes: full.notes,
      credential_type: full.credential_type,
      sort_order: full.sort_order,
      icon: full.icon,
      color: full.color,
      is_favorite: full.is_favorite,
      created_at: full.created_at,
      updated_at: full.updated_at,
    });
  }

  // Build export folders
  const exportFolders: ExportFolder[] = scopeFolders.map(f => ({
    id: f.id,
    name: f.name,
    parent_id: f.parent_id,
    sort_order: f.sort_order,
    icon: f.icon,
    color: f.color,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));

  // Derive vault name from file path
  const vaultPath = vault.getFilePath();
  const vaultName = vaultPath.split(/[/\\]/).pop()?.replace('.conduit', '') ?? 'Vault';

  const payload: ExportPayload = {
    format_version: 1,
    exported_at: new Date().toISOString(),
    source_vault_name: vaultName,
    scope: options.scope,
    scope_path: scopePath,
    folders: exportFolders,
    entries: exportEntries,
  };

  const json = JSON.stringify(payload);
  const encrypted = encryptPayload(json, options.passphrase);
  fs.writeFileSync(options.outputPath, encrypted);

  return { folderCount: exportFolders.length, entryCount: exportEntries.length };
}

// ── Validation ─────────────────────────────────────────────────────

function readExportFile(filePath: string): Buffer {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_EXPORT_SIZE) {
    throw new Error(`Export file is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`);
  }
  if (stat.size < MIN_BLOB_SIZE) {
    throw new Error('Export file is too short or corrupted');
  }
  return fs.readFileSync(filePath);
}

function validatePayload(raw: unknown): ExportPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid export: payload is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format_version !== 1) {
    throw new Error(`Unsupported export format version: ${obj.format_version}`);
  }
  if (!Array.isArray(obj.folders)) {
    throw new Error('Invalid export: missing folders array');
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error('Invalid export: missing entries array');
  }
  for (const entry of obj.entries) {
    const e = entry as Record<string, unknown>;
    if (!e.id || !e.name || !e.entry_type) {
      throw new Error('Invalid export: entry missing required fields (id, name, entry_type)');
    }
    if (!VALID_ENTRY_TYPES.has(e.entry_type as string)) {
      throw new Error(`Invalid export: unknown entry type "${e.entry_type}"`);
    }
  }
  for (const folder of obj.folders) {
    const f = folder as Record<string, unknown>;
    if (!f.id || !f.name) {
      throw new Error('Invalid export: folder missing required fields (id, name)');
    }
  }
  return raw as ExportPayload;
}

// ── Preview ────────────────────────────────────────────────────────

/**
 * Decrypt and preview an export file without importing.
 * Returns metadata with secrets stripped.
 */
export function decryptAndPreview(filePath: string, passphrase: string): ImportPreview {
  const blob = readExportFile(filePath);
  const json = decryptPayload(blob, passphrase);
  const payload = validatePayload(JSON.parse(json));

  // Count entry types
  const typeCounts: Record<string, number> = {};
  for (const entry of payload.entries) {
    typeCounts[entry.entry_type] = (typeCounts[entry.entry_type] ?? 0) + 1;
  }

  return {
    source_vault_name: payload.source_vault_name,
    exported_at: payload.exported_at,
    scope: payload.scope,
    scope_path: payload.scope_path,
    folder_count: payload.folders.length,
    entry_count: payload.entries.length,
    entry_type_counts: typeCounts,
    folder_tree: payload.folders.map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id })),
  };
}

// ── Import ─────────────────────────────────────────────────────────

/**
 * Import entries and folders from a .conduit-export file into a vault.
 *
 * For full-vault exports: everything is imported into the vault root.
 * For folder exports: root-level folders (parent not in export) are matched
 * by name to existing root-level folders in the vault, or created if no match.
 */
export function importIntoVault(
  vault: ConduitVault,
  filePath: string,
  passphrase: string,
  _options: ImportOptions = {},
): ImportResult {
  if (!vault.isUnlocked()) {
    throw new Error('Vault must be unlocked to import');
  }

  const blob = readExportFile(filePath);
  const json = decryptPayload(blob, passphrase);
  const payload = validatePayload(JSON.parse(json));

  const exportFolderIds = new Set(payload.folders.map(f => f.id));
  const isFolderScope = payload.scope === 'folder';

  // Sort folders by depth (parents first) for topological creation order
  const sortedFolders = topologicalSortFolders(payload.folders);

  let foldersCreated = 0;
  let entriesCreated = 0;
  let credentialRefsRemapped = 0;
  let credentialRefsCleared = 0;

  // For folder-scoped imports, build a name→id map of existing root-level folders
  // so we can match exported root folders by name instead of always creating new ones
  const existingRootFolderMap = new Map<string, string>();
  if (isFolderScope) {
    for (const f of vault.listFolders()) {
      if (!f.parent_id) {
        // Only use the first folder with that name (avoid ambiguity)
        if (!existingRootFolderMap.has(f.name)) {
          existingRootFolderMap.set(f.name, f.id);
        }
      }
    }
  }

  // Create folders, capturing old→new ID mapping from the vault's returned IDs
  const actualFolderIdMap = new Map<string, string>();

  for (const folder of sortedFolders) {
    const isRootInExport = !folder.parent_id || !exportFolderIds.has(folder.parent_id);

    if (isRootInExport && isFolderScope) {
      // For folder-scoped imports, try to match by name to an existing root folder
      const existingId = existingRootFolderMap.get(folder.name);
      if (existingId) {
        actualFolderIdMap.set(folder.id, existingId);
        // Don't increment foldersCreated — we're reusing an existing folder
        continue;
      }
    }

    let parentId: string | null;
    if (folder.parent_id && exportFolderIds.has(folder.parent_id)) {
      parentId = actualFolderIdMap.get(folder.parent_id) ?? null;
    } else {
      parentId = null;
    }

    const created = vault.createFolder({
      name: folder.name,
      parent_id: parentId,
      icon: folder.icon,
      color: folder.color,
    });
    // Restore sort_order (createFolder defaults to 0)
    if (folder.sort_order !== 0) {
      vault.updateFolder(created.id, { sort_order: folder.sort_order });
    }
    actualFolderIdMap.set(folder.id, created.id);
    foldersCreated++;
  }

  // Build a set of credential entry IDs in the export (for remapping credential_id)
  const exportEntryIds = new Set(payload.entries.map(e => e.id));

  // Create credential-type entries first (so credential_id refs can resolve)
  const credentialEntries = payload.entries.filter(e => e.entry_type === 'credential');
  const otherEntries = payload.entries.filter(e => e.entry_type !== 'credential');

  const actualEntryIdMap = new Map<string, string>();

  const createEntry = (entry: ExportEntry) => {
    // Remap folder_id
    let folderId: string | null = null;
    if (entry.folder_id) {
      folderId = actualFolderIdMap.get(entry.folder_id) ?? null;
    }

    // Remap credential_id
    let credentialId: string | null = null;
    if (entry.credential_id) {
      if (exportEntryIds.has(entry.credential_id)) {
        // The referenced credential is in the export — use remapped ID
        credentialId = actualEntryIdMap.get(entry.credential_id) ?? null;
        if (credentialId) {
          credentialRefsRemapped++;
        } else {
          // Credential hasn't been created yet (shouldn't happen since we
          // create credentials first, but handle gracefully)
          credentialRefsCleared++;
        }
      } else {
        // Credential is outside the export — clear the reference
        credentialRefsCleared++;
      }
    }

    const created = vault.createEntry({
      name: entry.name,
      entry_type: entry.entry_type as 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential',
      folder_id: folderId,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      password: entry.password,
      domain: entry.domain,
      private_key: entry.private_key,
      credential_id: credentialId,
      config: entry.config,
      tags: entry.tags,
      notes: entry.notes,
      credential_type: entry.credential_type,
      icon: entry.icon,
      color: entry.color,
    });

    // Restore sort_order and is_favorite (createEntry defaults to 0/false)
    if (entry.sort_order !== 0 || entry.is_favorite) {
      vault.updateEntry(created.id, {
        sort_order: entry.sort_order,
        is_favorite: entry.is_favorite,
      });
    }

    actualEntryIdMap.set(entry.id, created.id);
    entriesCreated++;
  };

  // Create credentials first, then the rest
  for (const entry of credentialEntries) {
    createEntry(entry);
  }
  for (const entry of otherEntries) {
    createEntry(entry);
  }

  return {
    foldersCreated,
    entriesCreated,
    credentialRefsRemapped,
    credentialRefsCleared,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function buildFolderPath(folderId: string, allFolders: FolderData[]): string {
  const folderMap = new Map(allFolders.map(f => [f.id, f]));
  const parts: string[] = [];
  const visited = new Set<string>();
  let current = folderMap.get(folderId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(current.name);
    current = current.parent_id ? folderMap.get(current.parent_id) : undefined;
  }

  return '/' + parts.join('/');
}

function topologicalSortFolders(folders: ExportFolder[]): ExportFolder[] {
  const folderMap = new Map(folders.map(f => [f.id, f]));
  const exportIds = new Set(folders.map(f => f.id));
  const sorted: ExportFolder[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection

  const visit = (folder: ExportFolder) => {
    if (visited.has(folder.id)) return;
    if (visiting.has(folder.id)) {
      // Cycle detected — skip this folder's parent link
      visiting.delete(folder.id);
      visited.add(folder.id);
      sorted.push(folder);
      return;
    }
    visiting.add(folder.id);

    // Visit parent first (if it's in the export)
    if (folder.parent_id && exportIds.has(folder.parent_id)) {
      const parent = folderMap.get(folder.parent_id);
      if (parent) visit(parent);
    }

    visiting.delete(folder.id);
    visited.add(folder.id);
    sorted.push(folder);
  };

  for (const folder of folders) {
    visit(folder);
  }

  return sorted;
}
