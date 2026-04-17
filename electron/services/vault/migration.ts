/**
 * Migration utility: old split format -> new unified .conduit vault.
 *
 * Reads:
 * - connections.json (old connection list)
 * - vault.db + vault.salt (old credential vault)
 *
 * Creates a new .conduit file with all data merged.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as crypto from './crypto.js';
import { ConduitVault } from './vault.js';

interface OldConnection {
  id: string;
  name: string;
  connection_type: string;
  host: string | null;
  port: number | null;
  credential_id: string | null;
  folder_id: string | null;
}

interface OldCredentialRow {
  id: string;
  name: string;
  username: string | null;
  password_encrypted: Buffer | null;
  domain: string | null;
  private_key_encrypted: Buffer | null;
  tags: string;
  created_at: string;
}

export interface MigrationResult {
  connectionsImported: number;
  credentialsImported: number;
  errors: string[];
}

/**
 * Migrate old vault files to a new .conduit file.
 *
 * @param connectionsPath - Path to old connections.json
 * @param oldVaultPath - Path to old vault.db
 * @param oldSaltPath - Path to old vault.salt
 * @param newVaultPath - Path for the new .conduit file
 * @param masterPassword - Master password (used for both old decrypt and new encrypt)
 */
export function migrateToConduit(
  connectionsPath: string,
  oldVaultPath: string,
  oldSaltPath: string,
  newVaultPath: string,
  masterPassword: string,
): MigrationResult {
  const result: MigrationResult = {
    connectionsImported: 0,
    credentialsImported: 0,
    errors: [],
  };

  // Create new vault
  const vault = new ConduitVault(newVaultPath);
  vault.initialize(masterPassword);

  // ── Migrate credentials ──────────────────────────────────────────

  if (fs.existsSync(oldVaultPath) && fs.existsSync(oldSaltPath)) {
    try {
      const salt = fs.readFileSync(oldSaltPath);
      const oldKey = crypto.deriveKey(masterPassword, salt);
      const oldDb = new Database(oldVaultPath);

      const rows = oldDb.prepare('SELECT * FROM credentials').all() as OldCredentialRow[];

      for (const row of rows) {
        try {
          let password: string | null = null;
          let privateKey: string | null = null;

          if (row.password_encrypted) {
            password = crypto.decrypt(row.password_encrypted, oldKey).toString('utf-8');
          }
          if (row.private_key_encrypted) {
            privateKey = crypto.decrypt(row.private_key_encrypted, oldKey).toString('utf-8');
          }

          const tags = row.tags ? JSON.parse(row.tags) : [];

          vault.createEntry({
            name: row.name,
            entry_type: 'credential',
            username: row.username,
            password,
            domain: row.domain,
            private_key: privateKey,
            tags,
          });

          result.credentialsImported++;
        } catch (e) {
          result.errors.push(`Failed to migrate credential "${row.name}": ${e}`);
        }
      }

      oldDb.close();
    } catch (e) {
      result.errors.push(`Failed to open old vault: ${e}`);
    }
  }

  // ── Migrate connections ──────────────────────────────────────────

  if (fs.existsSync(connectionsPath)) {
    try {
      const data = fs.readFileSync(connectionsPath, 'utf-8');
      const connections: OldConnection[] = JSON.parse(data);

      for (const conn of connections) {
        try {
          const entryType = conn.connection_type as 'ssh' | 'rdp' | 'vnc' | 'web';
          if (!['ssh', 'rdp', 'vnc', 'web'].includes(entryType)) {
            result.errors.push(`Skipped connection "${conn.name}" with unsupported type: ${conn.connection_type}`);
            continue;
          }

          vault.createEntry({
            name: conn.name,
            entry_type: entryType,
            host: conn.host,
            port: conn.port,
            // Note: credential_id from old format may not map to new IDs
            // since credentials were re-created with new IDs above
          });

          result.connectionsImported++;
        } catch (e) {
          result.errors.push(`Failed to migrate connection "${conn.name}": ${e}`);
        }
      }
    } catch (e) {
      result.errors.push(`Failed to read connections.json: ${e}`);
    }
  }

  vault.lock();
  return result;
}
