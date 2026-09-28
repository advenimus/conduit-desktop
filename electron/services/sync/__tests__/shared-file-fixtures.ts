// Fixtures for the shared-file, file-watch and replica tests: synced files made from a real
// legacy vault (genesis + VACUUM INTO, the way a new build publishes), variants for every
// classify class, and checks for SQLite side files next to a path.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { genesisFromContent } from '../genesis.js';
import { deriveEpochKeys, makeImplicitProvider } from '../hashing.js';
import { materialize } from '../materialize.js';
import { ensureSyncSchema } from '../schema.js';
import { vacuumInto } from '../shared-file.js';
import { loadContent, saveState } from '../state-store.js';
import type { LegacySource } from './core-e2e-harness.js';
import { MemoryLogger } from './host-fakes.js';

export const SIDE_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** Names of SQLite companion files that exist next to `file`. */
export function sideFilesNextTo(file: string): string[] {
  return SIDE_SUFFIXES.filter((s) => fs.existsSync(`${file}${s}`)).map((s) => `${path.basename(file)}${s}`);
}

/** Header bytes 18/19: 1/1 rollback journal, 2/2 WAL. */
export function journalBytes(bytes: Buffer): [number, number] {
  return [bytes[18] ?? -1, bytes[19] ?? -1];
}

export function pageSizeOf(bytes: Buffer): number {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

/**
 * Bytes of a synced file for the legacy source: genesis on a private copy, materialized and
 * saved, then VACUUM INTO (rollback-journal output). `lineageId` defaults to the source's.
 */
export function makeSyncedBytes(workDir: string, source: LegacySource, lineageId: string = source.lineageId): Buffer {
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const w = path.join(workDir, `synced-src-${tag}.conduit`);
  const out = path.join(workDir, `synced-out-${tag}.conduit`);
  fs.writeFileSync(w, source.bytes);
  const db = new Database(w);
  try {
    ensureSyncSchema(db);
    const k0 = deriveEpochKeys(source.key, lineageId);
    const content = loadContent(db);
    const g = genesisFromContent({ content, genesisId: source.genesisId, lineageId, k0 });
    const epoch = g.state.epochs.get(k0.epochId) ?? null;
    const m = materialize(g.state, content, g.cache, { implicit: makeImplicitProvider(k0.kSync), currentEpoch: epoch });
    saveState(db, { state: m.state, plan: m.plan, cache: m.cache, baseline: null });
    vacuumInto(db, out, new MemoryLogger());
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(w, { force: true });
  return bytes;
}

/** Applies `edit` to a private copy of `bytes` (rollback journal, no side files) and returns the result. */
export function editedBytes(workDir: string, bytes: Buffer, edit: (db: Database.Database) => void): Buffer {
  const file = path.join(workDir, `edit-${Date.now()}-${Math.random().toString(16).slice(2)}.conduit`);
  fs.writeFileSync(file, bytes);
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    edit(db);
  } finally {
    db.close();
  }
  const out = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return out;
}

/** A valid SQLite file that is not a Conduit vault. */
export function notAVaultBytes(workDir: string): Buffer {
  const file = path.join(workDir, `other-${Date.now()}.sqlite`);
  const db = new Database(file);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES (\'hello\')');
  db.close();
  const out = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return out;
}
