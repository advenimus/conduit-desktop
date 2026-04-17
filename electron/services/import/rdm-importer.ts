/**
 * RDM import orchestrator.
 *
 * Takes parsed preview entries and creates folders, credentials,
 * and connection entries in the Conduit vault.
 */

import type { ConduitVault, FolderData } from '../vault/vault.js';
import type {
  ImportPreviewEntry,
  ImportEntryResult,
  ImportResult,
  DuplicateStrategy,
} from './types.js';

export interface ImportOptions {
  /** Max entries allowed (tier limit). -1 = unlimited. */
  maxEntries: number;
  /** Current entry count in the vault. */
  existingEntryCount: number;
  /** How to handle duplicate entries. */
  duplicateStrategy?: DuplicateStrategy;
}

/**
 * Detect duplicates by matching name + entry_type + host against existing vault entries.
 * Mutates the entries in-place, setting isDuplicate and existingEntryId.
 */
export function detectDuplicates(
  entries: ImportPreviewEntry[],
  vault: ConduitVault,
): void {
  const existingEntries = vault.listEntries();

  // Build lookup keyed by "name::entry_type::host" (lowercased)
  const lookup = new Map<string, string>();
  for (const existing of existingEntries) {
    const key = `${existing.name.toLowerCase()}::${existing.entry_type}::${(existing.host ?? '').toLowerCase()}`;
    lookup.set(key, existing.id);
  }

  for (const entry of entries) {
    if (entry.status === 'unsupported') continue;

    const entryType = entry.conduitType === 'folder' ? 'folder' : entry.conduitType;
    const key = `${entry.name.toLowerCase()}::${entryType}::${(entry.host ?? '').toLowerCase()}`;
    const existingId = lookup.get(key);

    if (existingId) {
      entry.isDuplicate = true;
      entry.existingEntryId = existingId;
      if (entry.status === 'ready') {
        entry.status = 'duplicate';
      }
    }
  }
}

/**
 * Execute the import of parsed RDM entries into the vault.
 */
export function executeImport(
  vault: ConduitVault,
  entries: ImportPreviewEntry[],
  options: ImportOptions,
): ImportResult {
  const results: ImportEntryResult[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // ── 1. Compute tier budget ──────────────────────────────────────
  const remaining = options.maxEntries === -1
    ? Infinity
    : Math.max(0, options.maxEntries - options.existingEntryCount);

  // Track which entries are tier-limited (don't mutate input)
  const tierLimited = new Set<string>();
  let budgetUsed = 0;
  for (const entry of entries) {
    if (entry.status === 'unsupported') continue;
    if (entry.conduitType === 'folder' && !entry.isGroupCredential) continue;
    budgetUsed++;
    if (budgetUsed > remaining) {
      tierLimited.add(entry.rdmId);
    }
  }

  // ── 2. Build folder tree ────────────────────────────────────────
  const existingFolders = vault.listFolders();
  const folderMap = new Map<string, string>(); // path → conduit folder ID

  // Index existing folders by (name, parent_id) for dedup
  const existingByNameParent = new Map<string, FolderData>();
  for (const f of existingFolders) {
    existingByNameParent.set(`${f.name}::${f.parent_id ?? 'root'}`, f);
  }

  // Collect all unique folder paths and sort by depth
  const folderPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.folderPath) {
      // Add all ancestor paths too
      const parts = entry.folderPath.split('\\');
      for (let i = 1; i <= parts.length; i++) {
        folderPaths.add(parts.slice(0, i).join('\\'));
      }
    }
  }

  const sortedPaths = Array.from(folderPaths).sort((a, b) => {
    const depthA = a.split('\\').length;
    const depthB = b.split('\\').length;
    return depthA - depthB;
  });

  // Create folders from root down
  for (const folderPath of sortedPaths) {
    const parts = folderPath.split('\\');
    const folderName = parts[parts.length - 1];
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('\\') : null;
    const parentId = parentPath ? (folderMap.get(parentPath) ?? null) : null;

    // Check for existing folder with same name + parent
    const existingKey = `${folderName}::${parentId ?? 'root'}`;
    const existing = existingByNameParent.get(existingKey);

    if (existing) {
      folderMap.set(folderPath, existing.id);
    } else {
      try {
        const folder = vault.createFolder({ name: folderName, parent_id: parentId });
        folderMap.set(folderPath, folder.id);
        existingByNameParent.set(existingKey, folder);
      } catch (err) {
        console.error(`[import] Failed to create folder "${folderPath}":`, err);
      }
    }
  }

  // ── 3. Create entries ───────────────────────────────────────────
  const duplicateStrategy = options.duplicateStrategy ?? 'skip';

  // Map RDM ID → Conduit ID for credential references
  const rdmToConduitId = new Map<string, string>();

  // First pass: create Group credentials (so they're available for references)
  for (const entry of entries) {
    if (!entry.isGroupCredential) continue;

    if (entry.status === 'unsupported' || tierLimited.has(entry.rdmId)) {
      results.push({
        name: entry.name,
        conduitType: 'credential',
        status: 'skipped',
        message: tierLimited.has(entry.rdmId) ? 'Skipped: connection limit reached' : (entry.statusMessage ?? 'Skipped'),
        conduitId: null,
      });
      skipped++;
      continue;
    }

    // Handle duplicate
    if (entry.isDuplicate && entry.existingEntryId) {
      if (duplicateStrategy === 'skip') {
        rdmToConduitId.set(entry.rdmId, entry.existingEntryId);
        results.push({
          name: entry.name,
          conduitType: 'credential',
          status: 'skipped',
          message: 'Skipped: duplicate',
          conduitId: entry.existingEntryId,
        });
        skipped++;
        continue;
      }
      // overwrite
      try {
        const folderId = entry.folderPath ? (folderMap.get(entry.folderPath) ?? null) : null;
        vault.updateEntry(entry.existingEntryId, {
          name: `${entry.name} (Credential)`,
          username: entry.username,
          password: entry.password,
          folder_id: folderId,
        });
        rdmToConduitId.set(entry.rdmId, entry.existingEntryId);
        imported++;
        results.push({
          name: entry.name,
          conduitType: 'credential',
          status: 'overwritten',
          message: 'Overwritten',
          conduitId: entry.existingEntryId,
        });
        continue;
      } catch (err) {
        errors++;
        results.push({
          name: entry.name,
          conduitType: 'credential',
          status: 'error',
          message: `Failed to overwrite: ${err instanceof Error ? err.message : String(err)}`,
          conduitId: null,
        });
        continue;
      }
    }

    const folderId = entry.folderPath ? (folderMap.get(entry.folderPath) ?? null) : null;

    try {
      const meta = vault.createEntry({
        name: `${entry.name} (Credential)`,
        entry_type: 'credential',
        folder_id: folderId,
        username: entry.username,
        password: entry.password,
      });

      rdmToConduitId.set(entry.rdmId, meta.id);
      imported++;
      results.push({
        name: entry.name,
        conduitType: 'credential',
        status: 'imported',
        message: entry.status === 'decrypt-failed'
          ? 'Imported without password (decryption failed)'
          : 'Imported',
        conduitId: meta.id,
      });
    } catch (err) {
      errors++;
      results.push({
        name: entry.name,
        conduitType: 'credential',
        status: 'error',
        message: `Failed to create: ${err instanceof Error ? err.message : String(err)}`,
        conduitId: null,
      });
    }
  }

  // Second pass: create connection entries
  for (const entry of entries) {
    if (entry.isGroupCredential) continue; // Already processed
    if (entry.conduitType === 'folder') continue; // Pure folders (no creds) are just structure

    if (entry.status === 'unsupported') {
      results.push({
        name: entry.name,
        conduitType: entry.conduitType,
        status: 'skipped',
        message: entry.statusMessage ?? 'Unsupported type',
        conduitId: null,
      });
      skipped++;
      continue;
    }

    if (tierLimited.has(entry.rdmId)) {
      results.push({
        name: entry.name,
        conduitType: entry.conduitType,
        status: 'skipped',
        message: 'Skipped: connection limit reached',
        conduitId: null,
      });
      skipped++;
      continue;
    }

    const folderId = entry.folderPath ? (folderMap.get(entry.folderPath) ?? null) : null;

    // Resolve credential reference
    let credentialId: string | null = null;
    if (entry.credentialConnectionId) {
      credentialId = rdmToConduitId.get(entry.credentialConnectionId) ?? null;
      if (!credentialId) {
        console.warn(
          `[import] Entry "${entry.name}" references credential ${entry.credentialConnectionId} which was not found in the export`,
        );
      }
    }

    // Handle duplicate
    if (entry.isDuplicate && entry.existingEntryId) {
      if (duplicateStrategy === 'skip') {
        rdmToConduitId.set(entry.rdmId, entry.existingEntryId);
        results.push({
          name: entry.name,
          conduitType: entry.conduitType,
          status: 'skipped',
          message: 'Skipped: duplicate',
          conduitId: entry.existingEntryId,
        });
        skipped++;
        continue;
      }
      // overwrite
      try {
        vault.updateEntry(entry.existingEntryId, {
          name: entry.name,
          host: entry.host,
          port: entry.port,
          username: entry.username,
          password: entry.password,
          domain: entry.domain,
          credential_id: credentialId,
          config: entry.config,
          notes: entry.notes,
          folder_id: folderId,
        });
        rdmToConduitId.set(entry.rdmId, entry.existingEntryId);
        imported++;
        results.push({
          name: entry.name,
          conduitType: entry.conduitType,
          status: 'overwritten',
          message: 'Overwritten',
          conduitId: entry.existingEntryId,
        });
        continue;
      } catch (err) {
        errors++;
        results.push({
          name: entry.name,
          conduitType: entry.conduitType,
          status: 'error',
          message: `Failed to overwrite: ${err instanceof Error ? err.message : String(err)}`,
          conduitId: null,
        });
        continue;
      }
    }

    try {
      const meta = vault.createEntry({
        name: entry.name,
        entry_type: entry.conduitType as 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential' | 'document' | 'command',
        folder_id: folderId,
        host: entry.host,
        port: entry.port,
        username: entry.username,
        password: entry.password,
        domain: entry.domain,
        credential_id: credentialId,
        config: entry.config,
        notes: entry.notes,
      });

      rdmToConduitId.set(entry.rdmId, meta.id);
      imported++;

      let message = 'Imported';
      if (entry.status === 'decrypt-failed') {
        message = 'Imported without password (decryption failed)';
      }
      if (credentialId) {
        message += ' (with credential reference)';
      }

      results.push({
        name: entry.name,
        conduitType: entry.conduitType,
        status: 'imported',
        message,
        conduitId: meta.id,
      });
    } catch (err) {
      errors++;
      results.push({
        name: entry.name,
        conduitType: entry.conduitType,
        status: 'error',
        message: `Failed to create: ${err instanceof Error ? err.message : String(err)}`,
        conduitId: null,
      });
    }
  }

  // Pure folder entries are structural (not imported/skipped/errored),
  // so exclude them from totalParsed to keep the math consistent.
  const pureFolderCount = entries.filter(
    (e) => e.conduitType === 'folder' && !e.isGroupCredential,
  ).length;

  return {
    totalParsed: entries.length - pureFolderCount,
    imported,
    skipped,
    errors,
    entries: results,
  };
}
