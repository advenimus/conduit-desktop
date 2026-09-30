// Legacy writer driver: desktop 0.17 = the existing ConduitVault/ConduitDatabase editing S IN
// PLACE (WAL mode, so S-wal/S-shm exist while it is open; each mutator checkpoints with TRUNCATE,
// so an idle 0.17 leaves an empty WAL and an unchanged -shm), including an idle open
// connection, a quit that leaves uncheckpointed WAL frames, and a password change.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { vi } from 'vitest';
import { ConduitVault } from '../../../vault/vault.js';

export type SimClock = () => number;

/**
 * Runs `fn` with Date faked to simulated time: ConduitVault stamps created_at/updated_at with
 * `new Date()`, and a legacy app must write the same time line as every other device.
 */
export function withSimDate<T>(ms: number, fn: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

export class LegacyDesktop {
  private vault: ConduitVault | null = null;

  constructor(
    readonly file: string,
    private key: Buffer,
    private readonly now: SimClock,
  ) {}

  get isOpen(): boolean {
    return this.vault !== null;
  }

  /** Unlocks S in place with the key (creates S-wal and S-shm next to S). */
  open(): ConduitVault {
    if (this.vault !== null) return this.vault;
    const v = new ConduitVault(this.file);
    withSimDate(this.now(), () => v.unlockWithKey(this.key));
    this.vault = v;
    this.touch();
    return v;
  }

  /** One or more ConduitVault mutations (each checkpoints S); files get simulated mtimes. */
  edit<T>(fn: (v: ConduitVault) => T): T {
    const v = this.open();
    const out = withSimDate(this.now(), () => fn(v));
    this.touch();
    return out;
  }

  /** Clean quit: the last connection closes, SQLite checkpoints and removes -wal/-shm. */
  close(): void {
    this.vault?.lock();
    this.vault = null;
    if (fs.existsSync(this.file)) this.touch();
  }

  /** Legacy password change (real PBKDF2, 600k rounds): salt and every secret change in place. */
  changePassword(oldPassword: string, newPassword: string): Buffer {
    const newKey = this.edit((v) => v.changePassword(oldPassword, newPassword));
    this.key = Buffer.from(newKey);
    return this.key;
  }

  /**
   * 0.17 quit while unlocked with writes still in the WAL: `write` runs on a WAL connection with
   * auto-checkpoints off; the three files are then left exactly as they were on disk.
   */
  crashWithWal(write: (db: Database.Database) => void): void {
    this.close();
    const db = new Database(this.file);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.prepare('SELECT count(*) AS n FROM vault_meta').get();
    write(db);
    const files = ['', '-wal', '-shm'].map((suffix) => {
      const p = `${this.file}${suffix}`;
      return { p, bytes: fs.existsSync(p) ? fs.readFileSync(p) : null };
    });
    db.close();
    for (const f of files) {
      if (f.bytes === null) fs.rmSync(f.p, { force: true });
      else fs.writeFileSync(f.p, f.bytes);
    }
    this.touch();
  }

  /** Every file this app wrote carries the legacy device's simulated time. */
  touch(): void {
    const t = new Date(this.now());
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${this.file}${suffix}`;
      if (fs.existsSync(p)) fs.utimesSync(p, t, t);
    }
  }
}
