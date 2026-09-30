// Legacy writer driver: an iOS 1.0.5 emulator (map/ios-app.md 1d/1e). It works on a private
// sandbox copy of S: stage() copies S plus any -wal/-shm companions and lets SQLite fold them
// (companion folding), poll() re-stages when S's mtime is newer than the last one it knew,
// editor saves are whole-row UPDATEs built from the row captured when the editor opened (stale
// snapshot, secrets included) with a rebuilt config, GRDB dates and '' for empty text, never
// touching parent_entry_id, and writeBack() overwrites S IN PLACE after removeCompanions().
// It never re-checks its key after a pull, so it can write secrets under a stale key.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seal, type Row } from './vault-ops.js';
import type { SimClock } from './legacy-desktop.js';

/** Columns iOS 1.0.5's Entry model writes on save: every column except parent_entry_id. */
const IOS_ENTRY_COLUMNS = [
  'name', 'entry_type', 'folder_id', 'sort_order', 'host', 'port', 'credential_id', 'username',
  'password_encrypted', 'domain', 'private_key_encrypted', 'totp_secret_encrypted', 'icon', 'color',
  'credential_type', 'config', 'tags', 'is_favorite', 'notes', 'created_at', 'updated_at',
] as const;

const IOS_EMPTY_TEXT = ['host', 'username', 'domain'] as const;

/** GRDB's default date text: 'YYYY-MM-DD HH:MM:SS.SSS' (UTC). */
export function grdb(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** iOS 1.0.5 rebuilds config on save: documents and credentials get {}, RDP always gets sharedFolders: []. */
export function rebuildConfig(entryType: string, configText: string): string {
  if (entryType === 'document' || entryType === 'credential') return '{}';
  if (entryType !== 'rdp') return configText;
  const parsed = JSON.parse(configText) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, sharedFolders: [] });
}

export type EditorSnapshot = Readonly<Row>;

export class Ios105 {
  readonly sandbox: string;
  lastKnownSourceMtime = 0;
  pendingWriteBack = false;

  constructor(
    readonly source: string,
    sandboxDir: string,
    /** The key iOS derived at its last unlock (never re-checked after a pull). */
    public key: Buffer,
    private readonly now: SimClock,
  ) {
    fs.mkdirSync(sandboxDir, { recursive: true });
    this.sandbox = path.join(sandboxDir, path.basename(source));
  }

  /** stageFromSource: copy S plus companions, fold the WAL, checkpoint, drop companions, swap in. */
  stage(): void {
    const incoming = `${this.sandbox}.incoming`;
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${incoming}${suffix}`, { force: true });
      const src = `${this.source}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${incoming}${suffix}`);
    }
    const db = new Database(incoming);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${incoming}${suffix}`, { force: true });
    fs.renameSync(incoming, this.sandbox);
    this.lastKnownSourceMtime = fs.statSync(this.source).mtimeMs;
  }

  /** The 5 s poll: flush a pending write-back first, then re-stage when S is newer. */
  poll(): boolean {
    if (this.pendingWriteBack) this.writeBack();
    const mtime = fs.statSync(this.source).mtimeMs;
    if (mtime <= this.lastKnownSourceMtime) return false;
    this.stage();
    return true;
  }

  private withDb<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(this.sandbox);
    try {
      db.pragma('foreign_keys = ON');
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** The row as the editor captured it when it opened. */
  openEditor(id: string): EditorSnapshot {
    const row = this.withDb((db) => db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined);
    if (row === undefined) throw new Error(`ios: no entry ${id}`);
    return Object.freeze({ ...row });
  }

  /** Editor save: whole-row UPDATE from the snapshot plus `patch` (plaintext `password` is sealed with iOS's key). */
  saveEditor(snapshot: EditorSnapshot, patch: Row): void {
    const next: Row = { ...snapshot, ...patch };
    if ('password' in patch) {
      delete next.password;
      next.password_encrypted = patch.password === null ? null : seal(this.key, String(patch.password));
    }
    for (const col of IOS_EMPTY_TEXT) if (next[col] === null) next[col] = '';
    next.config = rebuildConfig(String(next.entry_type), String(next.config));
    next.created_at = grdb(Date.parse(String(snapshot.created_at)));
    next.updated_at = grdb(this.now());
    const sets = IOS_ENTRY_COLUMNS.map((c) => `${c} = @${c}`).join(', ');
    const params = Object.fromEntries([...IOS_ENTRY_COLUMNS.map((c) => [c, next[c] ?? null]), ['id', snapshot.id]]);
    this.withDb((db) => db.prepare(`UPDATE entries SET ${sets} WHERE id = @id`).run(params));
    this.pendingWriteBack = true;
  }

  /** Open the editor and save at once (a fresh snapshot). */
  save(id: string, patch: Row): void {
    this.saveEditor(this.openEditor(id), patch);
  }

  insert(id: string, name: string, host: string): void {
    const t = grdb(this.now());
    this.withDb((db) =>
      db
        .prepare(
          `INSERT INTO entries (id, name, entry_type, host, username, domain, config, tags, created_at, updated_at)
           VALUES (?, ?, 'ssh', ?, '', '', '{}', '[]', ?, ?)`,
        )
        .run(id, name, host, t, t),
    );
    this.pendingWriteBack = true;
  }

  /** Hard delete (history cascades). */
  remove(id: string): void {
    this.withDb((db) => db.prepare('DELETE FROM entries WHERE id = ?').run(id));
    this.pendingWriteBack = true;
  }

  /** writeBack: removeCompanions(S), then the sandbox bytes overwrite S in place (same inode). */
  writeBack(): void {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${this.source}${suffix}`, { force: true });
    const bytes = fs.readFileSync(this.sandbox);
    const fd = fs.openSync(this.source, 'r+');
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const t = new Date(this.now());
    fs.utimesSync(this.source, t, t);
    this.lastKnownSourceMtime = fs.statSync(this.source).mtimeMs;
    this.pendingWriteBack = false;
  }

  /** Bytes of the sandbox as a file (a pre-sync copy made before the first genesis, row 56). */
  sandboxBytes(): Buffer {
    return fs.readFileSync(this.sandbox);
  }

  row(id: string): Row | undefined {
    return this.withDb((db) => db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined);
  }
}
