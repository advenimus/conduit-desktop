// Fixtures for the core end-to-end test: the legacy ConduitVault file both devices migrate,
// a comparable view of a working copy's content, content integrity checks, secret decryption
// and a compact summary of the conflict list.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ConduitVault } from '../../vault/vault.js';
import { decrypt } from '../../vault/crypto.js';
import { genesisIdOf, lineageIdFromSalt } from '../hashing.js';
import { ensurePasswordHistory } from '../schema.js';
import { loadContent } from '../state-store.js';
import type { ConflictGroup, ContentRow } from '../types.js';
import type { LegacySource } from './core-e2e-harness.js';

export const OLD_PASSWORD = 'correct horse battery staple';
export const NEW_PASSWORD = 'new master password 2026';

export interface SeedIds {
  readonly servers: string;
  readonly clients: string;
  readonly cred: string;
  readonly web: string;
  readonly db: string;
  readonly desk: string;
  readonly webHistory: string;
}

export interface LegacyFixture {
  readonly source: LegacySource;
  readonly ids: SeedIds;
}

function seed(vault: ConduitVault): SeedIds {
  const servers = vault.createFolder({ name: 'Servers' });
  const clients = vault.createFolder({ name: 'Clients' });
  const cred = vault.createEntry({ name: 'Shared admin', entry_type: 'credential', username: 'admin', password: 'cred-pw' });
  const web = vault.createEntry({
    name: 'web', entry_type: 'ssh', folder_id: servers.id, host: '10.0.0.1', port: 22,
    username: 'root', password: 'pw-web', tags: ['prod'], config: { keepalive: 30 },
  });
  const db = vault.createEntry({
    name: 'db', entry_type: 'ssh', folder_id: servers.id, host: '10.0.0.5', port: 5432,
    password: 'pw-db', credential_id: cred.id,
  });
  const desk = vault.createEntry({ name: 'desk', entry_type: 'rdp', folder_id: clients.id, host: 'desk.local', config: { resolution: '1080p' } });
  const webHistory = vault.recordPasswordHistory(web.id, 'root', 'pw-web-old', 'user');
  vault.getVaultId();
  return { servers: servers.id, clients: clients.id, cred: cred.id, web: web.id, db: db.id, desk: desk.id, webHistory };
}

/** A pre-sync vault written by the real ConduitVault (password based, like every personal vault). */
export function createLegacyVault(dir: string): LegacyFixture {
  const file = path.join(dir, 'Vault.conduit');
  const vault = new ConduitVault(file);
  vault.initialize(OLD_PASSWORD);
  const key = Buffer.from(vault.getEncryptionKey());
  const raw = new Database(file);
  ensurePasswordHistory(raw);
  raw.close();
  const ids = seed(vault);
  vault.lock();
  const bytes = fs.readFileSync(file);
  const probe = new Database(file, { readonly: true });
  const salt = (probe.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as { value: string }).value;
  probe.close();
  const lineageId = lineageIdFromSalt(salt);
  return { source: { bytes, key, lineageId, genesisId: genesisIdOf(bytes) }, ids };
}

// ---------- Comparable content ----------

type Plain = Record<string, unknown>;

function plainRow(row: ContentRow, withUpdatedAt: boolean): Plain {
  const out: Plain = {};
  for (const [col, v] of Object.entries(row)) {
    if (col === 'updated_at' && !withUpdatedAt) continue;
    out[col] = v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v;
  }
  return out;
}

function sortedRows(rows: ReadonlyMap<string, ContentRow>, withUpdatedAt: boolean): Plain[] {
  return [...rows.keys()].sort().map((id) => plainRow(rows.get(id) as ContentRow, withUpdatedAt));
}

/**
 * Every content row and vault_meta key, secrets as ciphertext hex. `updated_at` is left out
 * unless asked for: it is derived, not a register, and a row whose content does not change
 * keeps its stored text (4.6), so two converged devices may legitimately differ there.
 */
export function comparableContent(db: Database.Database, withUpdatedAt = false): Plain {
  const c = loadContent(db);
  return {
    entries: sortedRows(c.entries, withUpdatedAt),
    folders: sortedRows(c.folders, withUpdatedAt),
    history: sortedRows(c.history, withUpdatedAt),
    meta: Object.fromEntries([...c.meta.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

export function entryRow(db: Database.Database, id: string): Plain | undefined {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Plain | undefined;
}

export function folderParent(db: Database.Database, id: string): string | null | undefined {
  const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id) as { parent_id: string | null } | undefined;
  return row?.parent_id;
}

export function historyIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM password_history ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
}

// ---------- Integrity ----------

function chainProblems(links: ReadonlyMap<string, string | null>, what: string): string[] {
  const out: string[] = [];
  for (const start of links.keys()) {
    const seen = new Set<string>();
    let cur: string | null | undefined = start;
    while (cur !== null && cur !== undefined) {
      if (seen.has(cur)) {
        out.push(`${what} cycle through ${start}`);
        break;
      }
      seen.add(cur);
      cur = links.get(cur);
    }
  }
  return out;
}

/** Foreign-key violations plus folder and nested-entry cycles in the live tables (4.6 step 3). */
export function contentProblems(db: Database.Database): string[] {
  const fk = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number }>;
  const folders = db.prepare('SELECT id, parent_id FROM folders').all() as Array<{ id: string; parent_id: string | null }>;
  const entries = db.prepare('SELECT id, parent_entry_id FROM entries').all() as Array<{ id: string; parent_entry_id: string | null }>;
  return [
    ...fk.map((v) => `foreign key violation in ${v.table} rowid ${v.rowid}`),
    ...chainProblems(new Map(folders.map((f) => [f.id, f.parent_id])), 'folder'),
    ...chainProblems(new Map(entries.map((e) => [e.id, e.parent_entry_id])), 'entry'),
  ];
}

// ---------- Secrets ----------

const SECRET_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['entries', 'password_encrypted'],
  ['entries', 'private_key_encrypted'],
  ['entries', 'totp_secret_encrypted'],
  ['password_history', 'password_encrypted'],
];

/** Plaintext of every non-null secret cell, keyed "table.id.column"; throws if one does not open. */
export function decryptAllSecrets(db: Database.Database, key: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const [table, col] of SECRET_COLUMNS) {
    const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all() as Array<{ id: string; v: Buffer }>;
    for (const r of rows) out.set(`${table}.${r.id}.${col}`, decrypt(r.v, key).toString('utf8'));
  }
  return out;
}

// ---------- Conflicts ----------

export interface ConflictLine {
  readonly row: string;
  readonly kind: string;
  readonly detail: unknown;
}

/** One line per conflict item: field items list their distinct values, provisional first. */
export function conflictSummary(groups: readonly ConflictGroup[]): ConflictLine[] {
  const out: ConflictLine[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      switch (item.kind) {
        case 'field': {
          const versions = [...item.field.versions].sort((a, b) => Number(b.provisional) - Number(a.provisional));
          out.push({ row: g.row.rowId, kind: 'field', detail: { reg: item.field.key.reg, values: versions.map((v) => v.value) } });
          break;
        }
        case 'edit-delete':
          out.push({ row: g.row.rowId, kind: item.kind, detail: { deleted: item.deleted.length, edited: item.edited.length } });
          break;
        case 'folder-delete':
          out.push({ row: g.row.rowId, kind: item.kind, detail: { changedItems: item.changedItems.map((r) => r.rowId) } });
          break;
        case 'cycle':
          out.push({ row: g.row.rowId, kind: item.kind, detail: { rowIds: item.rowIds, movedToRoot: item.movedToRoot } });
          break;
        default:
          out.push({ row: g.row.rowId, kind: item.kind, detail: null });
      }
    }
  }
  return out;
}
