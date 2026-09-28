import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markWalJournalMode } from '../wal-header.js';
import { ConduitDatabase } from '../database.js';

const HEADER_WRITE_VERSION = 18;
const HEADER_READ_VERSION = 19;
const WAL_VERSION = 2;

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-wal-header-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Opens the file the way shipped iOS 1.0.5 does: journal_mode set inside a write transaction. */
function openLikeIos105(file: string): string {
  const db = new Database(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    db.exec('COMMIT');
    return String(mode);
  } finally {
    db.close();
  }
}

function header(file: string): [number, number] {
  const bytes = fs.readFileSync(file);
  return [bytes[HEADER_WRITE_VERSION], bytes[HEADER_READ_VERSION]];
}

describe('markWalJournalMode', () => {
  it('turns a VACUUM INTO copy into a file older apps can open, with no side files left', () => {
    const dir = tempDir();
    const src = new Database(path.join(dir, 'src.conduit'));
    src.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)');
    const copy = path.join(dir, 'copy.conduit');
    src.prepare('VACUUM INTO ?').run(copy);
    src.close();

    expect(() => openLikeIos105(copy)).toThrow(/cannot change into wal mode/);
    markWalJournalMode(copy);

    expect(header(copy)).toEqual([WAL_VERSION, WAL_VERSION]);
    expect(openLikeIos105(copy)).toBe('wal');
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('copy.conduit-'))).toEqual([]);
  });

  it('ConduitDatabase.vacuumInto writes a WAL-mode copy', () => {
    const dir = tempDir();
    const db = new ConduitDatabase(path.join(dir, 'vault.conduit'));
    const copy = path.join(dir, 'backup.conduit');
    db.vacuumInto(copy);
    db.close();
    expect(header(copy)).toEqual([WAL_VERSION, WAL_VERSION]);
    expect(openLikeIos105(copy)).toBe('wal');
  });
});
