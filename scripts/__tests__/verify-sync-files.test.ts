// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

interface SideFileWatch {
  violations(): { file: string; at: string }[];
  expectedSightings(): { file: string; at: string }[];
  expect<T>(fn: () => T | Promise<T>): Promise<T>;
  stop(): void;
}

// The harness is plain .mjs without type declarations.
const files = (await import('../verify/lib/sync-files.mjs' as string)) as {
  createSideFileWatch(root: string, opts?: { intervalMs?: number }): SideFileWatch;
  sqliteHeader(file: string): { magicOk: boolean; writeVersion: number; readVersion: number };
  openLikeIos105(file: string, scratch: string): { journalMode: string; quickCheck: string; schemaVersion: string | null };
  legacyEditInPlace(file: string, id: string, patch: Record<string, unknown>): string[];
  sharedEntries(file: string, scratch: string): { id: string; host: string | null }[];
  sideFilesNextTo(file: string): string[];
};

let dir: string;
let cloud: string;
let scratch: string;

/** A minimal vault file: entries + vault_meta, closed cleanly in the given journal mode. */
function makeVault(file: string, journal: 'wal' | 'delete'): void {
  const db = new Database(file);
  db.exec(`create table vault_meta (key text primary key, value text not null);
           create table entries (id text primary key, name text not null, host text, port integer, updated_at text not null);
           insert into vault_meta values ('schema_version', '10');
           insert into entries values ('e1', 'server', '10.0.0.1', 22, '2026-09-26T00:00:00.000Z');`);
  db.pragma(`journal_mode = ${journal}`);
  db.close();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-files-'));
  cloud = path.join(dir, 'cloud');
  scratch = path.join(dir, 'scratch');
  fs.mkdirSync(path.join(cloud, 's1'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('verify sync-files', () => {
  it('reads the header bytes 18/19 of WAL and rollback-journal files', () => {
    const wal = path.join(cloud, 's1', 'Wal.conduit');
    const rollback = path.join(cloud, 's1', 'Rollback.conduit');
    makeVault(wal, 'wal');
    makeVault(rollback, 'delete');
    expect(files.sqliteHeader(wal)).toEqual({ magicOk: true, writeVersion: 2, readVersion: 2 });
    expect(files.sqliteHeader(rollback)).toEqual({ magicOk: true, writeVersion: 1, readVersion: 1 });
  });

  it('opens a WAL file like iOS 1.0.5 and refuses a rollback-journal file the same way iOS does', () => {
    const wal = path.join(cloud, 's1', 'Wal.conduit');
    const rollback = path.join(cloud, 's1', 'Rollback.conduit');
    makeVault(wal, 'wal');
    makeVault(rollback, 'delete');
    expect(files.openLikeIos105(wal, scratch)).toEqual({ journalMode: 'wal', quickCheck: 'ok', schemaVersion: '10' });
    expect(() => files.openLikeIos105(rollback, scratch)).toThrow(/cannot change into wal mode from within a transaction/);
    expect(files.sideFilesNextTo(wal)).toEqual([]);
  });

  it('reads the shared file through a private copy and edits it in place like desktop 0.17, leaving no side files', () => {
    const vault = path.join(cloud, 's1', 'Vault.conduit');
    makeVault(vault, 'wal');
    expect(files.sharedEntries(vault, scratch).map((e) => e.host)).toEqual(['10.0.0.1']);
    expect(files.legacyEditInPlace(vault, 'e1', { host: '10.0.0.99' })).toEqual([]);
    expect(files.sharedEntries(vault, scratch).map((e) => e.host)).toEqual(['10.0.0.99']);
    expect(files.sideFilesNextTo(vault)).toEqual([]);
    expect(() => files.legacyEditInPlace(vault, 'missing', { host: 'x' })).toThrow('changed 0 rows');
  });

  it('reports side files in the cloud folder, except inside an expect() window', async () => {
    const vault = path.join(cloud, 's1', 'Vault.conduit');
    const watch = files.createSideFileWatch(cloud, { intervalMs: 20 });
    try {
      await watch.expect(async () => {
        fs.writeFileSync(`${vault}-shm`, '');
        await sleep(80);
        fs.rmSync(`${vault}-shm`);
      });
      expect(watch.violations()).toEqual([]);
      expect(watch.expectedSightings().map((s) => s.file)).toEqual([path.join('s1', 'Vault.conduit-shm')]);

      fs.writeFileSync(`${vault}-wal`, '');
      await sleep(80);
      fs.rmSync(`${vault}-wal`);
      fs.writeFileSync(`${vault}-journal`, '');
      await sleep(80);
      expect(watch.violations().map((v) => v.file)).toEqual([
        path.join('s1', 'Vault.conduit-wal'),
        path.join('s1', 'Vault.conduit-journal'),
      ]);
    } finally {
      watch.stop();
    }
  });
});
