/**
 * Marks a freshly written vault copy as a WAL-mode database.
 *
 * VACUUM INTO writes a rollback-journal file. Shipped iOS (1.0.5) runs
 * `PRAGMA journal_mode = WAL` inside a transaction when it opens a vault, which SQLite
 * refuses for a rollback-journal file ("cannot change into wal mode from within a
 * transaction"). Every vault copy that another app may open must therefore carry the WAL
 * header, as every vault written before multi-device sync did.
 */

import Database from 'better-sqlite3';

const WAL_MODE = 'wal';

/** Switches the file at `filePath` to WAL mode; closing it checkpoints and removes -wal/-shm. */
export function markWalJournalMode(filePath: string): void {
  const db = new Database(filePath);
  try {
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (String(mode).toLowerCase() !== WAL_MODE) {
      throw new Error(`could not switch the vault copy to WAL mode (got ${String(mode)})`);
    }
  } finally {
    db.close();
  }
}
