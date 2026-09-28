// SQL-level content writers and readers shared by the harness devices (W through the hook
// contract), the legacy drivers and the assertions. Secrets use the vault's AES-GCM format.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from '../../../vault/crypto.js';
import { loadFile } from '../../state-store.js';
import type { LoadedFile } from '../../types.js';

export interface EntrySpec {
  readonly id: string;
  readonly name?: string;
  readonly entry_type?: string;
  readonly folder_id?: string | null;
  readonly parent_entry_id?: string | null;
  readonly host?: string | null;
  readonly port?: number | null;
  readonly username?: string | null;
  readonly notes?: string | null;
  readonly credential_id?: string | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  /** Plaintext; sealed with `key`. */
  readonly password?: string | null;
}

export interface FolderSpec {
  readonly id: string;
  readonly name?: string;
  readonly parent_id?: string | null;
}

export type Row = Record<string, unknown>;

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function seal(key: Buffer, plain: string): Buffer {
  return encrypt(Buffer.from(plain, 'utf8'), key);
}

export function open(key: Buffer, ct: Buffer | null): string | null {
  return ct === null ? null : decrypt(ct, key).toString('utf8');
}

export function insertEntry(db: Database.Database, e: EntrySpec, nowIso: string, key: Buffer | null): void {
  const password = e.password === undefined || e.password === null || key === null ? null : seal(key, e.password);
  db.prepare(
    `INSERT INTO entries (id, name, entry_type, folder_id, parent_entry_id, host, port, username, notes,
       credential_id, config, tags, password_encrypted, created_at, updated_at)
     VALUES (@id, @name, @entry_type, @folder_id, @parent_entry_id, @host, @port, @username, @notes,
       @credential_id, @config, @tags, @password, @now, @now)`,
  ).run({
    id: e.id,
    name: e.name ?? `Entry ${e.id}`,
    entry_type: e.entry_type ?? 'ssh',
    folder_id: e.folder_id ?? null,
    parent_entry_id: e.parent_entry_id ?? null,
    host: e.host ?? null,
    port: e.port ?? null,
    username: e.username ?? null,
    notes: e.notes ?? null,
    credential_id: e.credential_id ?? null,
    config: JSON.stringify(e.config ?? {}),
    tags: JSON.stringify(e.tags ?? []),
    password,
    now: nowIso,
  });
}

/** Column update; `config`/`tags` objects are serialized, `password` is sealed with `key`. */
export function updateEntry(db: Database.Database, id: string, patch: Row, nowIso: string, key: Buffer | null = null): void {
  const cols: Row = { ...patch, updated_at: nowIso };
  if ('config' in cols && typeof cols.config !== 'string') cols.config = JSON.stringify(cols.config);
  if ('tags' in cols && typeof cols.tags !== 'string') cols.tags = JSON.stringify(cols.tags);
  if ('password' in cols) {
    const plain = cols.password as string | null;
    delete cols.password;
    cols.password_encrypted = plain === null || key === null ? null : seal(key, plain);
  }
  const sets = Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
  const res = db.prepare(`UPDATE entries SET ${sets} WHERE id = @id`).run({ ...cols, id });
  if (res.changes !== 1) throw new Error(`vault-ops: no entry ${id}`);
}

export function deleteEntries(db: Database.Database, ids: readonly string[]): void {
  const stmt = db.prepare('DELETE FROM entries WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function insertFolder(db: Database.Database, f: FolderSpec, nowIso: string): void {
  db.prepare('INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    f.id,
    f.name ?? `Folder ${f.id}`,
    f.parent_id ?? null,
    nowIso,
    nowIso,
  );
}

export function updateFolder(db: Database.Database, id: string, patch: Row, nowIso: string): void {
  const cols: Row = { ...patch, updated_at: nowIso };
  const sets = Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE folders SET ${sets} WHERE id = @id`).run({ ...cols, id });
}

/** Desktop's recursive folder delete: the folder, its subfolders and every entry inside them. */
export function deleteFolderRecursive(db: Database.Database, id: string): { folders: string[]; entries: string[] } {
  const folders = (
    db
      .prepare(
        `WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub`,
      )
      .all(id) as { id: string }[]
  ).map((r) => r.id);
  const marks = folders.map(() => '?').join(',');
  const entries = (db.prepare(`SELECT id FROM entries WHERE folder_id IN (${marks})`).all(...folders) as { id: string }[]).map((r) => r.id);
  deleteEntries(db, entries);
  const stmt = db.prepare('DELETE FROM folders WHERE id = ?');
  for (const f of [...folders].reverse()) stmt.run(f);
  return { folders, entries };
}

export function entryRow(db: Database.Database, id: string): Row | undefined {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined;
}

/** Reads a file through a private copy (never opens a shared file in place). */
export function withCopy<T>(file: string, scratch: string, read: (db: Database.Database) => T): T {
  fs.mkdirSync(scratch, { recursive: true });
  const copy = path.join(scratch, `read-${process.hrtime.bigint()}.conduit`);
  fs.copyFileSync(file, copy);
  const db = new Database(copy);
  try {
    return read(db);
  } finally {
    db.close();
    fs.rmSync(copy, { force: true });
  }
}

export function loadCopy(file: string, scratch: string): LoadedFile {
  return withCopy(file, scratch, (db) => loadFile(db));
}

/** Plain content of a file (entries, folders, history ids), comparable across devices. */
export function contentOf(db: Database.Database): { entries: Row[]; folders: Row[]; history: string[] } {
  const strip = (r: Row): Row => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'updated_at') continue;
      out[k] = Buffer.isBuffer(v) ? 'blob' : v;
    }
    return out;
  };
  const entries = (db.prepare('SELECT * FROM entries ORDER BY id').all() as Row[]).map(strip);
  const folders = (db.prepare('SELECT * FROM folders ORDER BY id').all() as Row[]).map(strip);
  const history = (db.prepare('SELECT id FROM password_history ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  return { entries, folders, history };
}
