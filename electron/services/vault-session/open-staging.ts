/**
 * Private copies read during an open (spec 6.3 steps 2 and 4): W's state is read from a copy
 * of w.conduit (plus its -wal when present), so nothing touches W before the password is
 * accepted; a private vault (3.2) is read the same way from the data folder, where the -wal
 * belongs to this app and may hold the newest vault_meta after a crash. Copies live in the
 * open's staging folder and are removed by the caller. Shared files never go through here
 * (shared-file.readShared stages S without its side files).
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { lineageIdFromSalt } from '../sync/hashing.js';
import { hasContentTables, hasSyncTables, readSyncFormat } from '../sync/schema.js';
import { loadFile } from '../sync/state-store.js';
import { SESSION_LOG_PREFIX, type SyncHost } from '../sync/host.js';
import { SYNC_FORMAT, type SyncState } from '../sync/types.js';
import type { FileKeyMeta } from '../sync/key-epoch.js';

export type StagingHost = Pick<SyncHost, 'fs' | 'random' | 'logger'>;

const WAL_SUFFIX = '-wal';
/** Files SQLite may leave next to a staged copy after it was opened. */
const COPY_SIDE_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
const COPY_PREFIX = 'peek-';
const COPY_EXT = '.conduit';
const COPY_RAND_BYTES = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLineageId(v: string): boolean {
  return UUID_RE.test(v);
}

/** Copies `src` (and `src`-wal when present) into `stagingDir`; returns the copy's path. */
export async function stageWithWal(src: string, stagingDir: string, host: StagingHost): Promise<string> {
  const name = `${COPY_PREFIX}${host.random.bytes(COPY_RAND_BYTES).toString('hex')}${COPY_EXT}`;
  const copy = path.join(stagingDir, name);
  await host.fs.copyFile(src, copy);
  if ((await host.fs.stat(`${src}${WAL_SUFFIX}`)) !== null) {
    await host.fs.copyFile(`${src}${WAL_SUFFIX}`, `${copy}${WAL_SUFFIX}`);
  }
  return copy;
}

/** Removes a staged copy and whatever SQLite left next to it. Never throws (logs). */
export async function removeStagedCopy(copy: string, host: StagingHost): Promise<void> {
  for (const p of [copy, ...COPY_SIDE_SUFFIXES.map((s) => `${copy}${s}`)]) {
    try {
      await host.fs.rm(p, { recursive: false, force: true });
    } catch (err) {
      host.logger.warn(`${SESSION_LOG_PREFIX} open: could not remove a staged copy`, { file: path.basename(p), code: errCode(err) });
    }
  }
}

/** W's state from a private copy of w.conduit (a temporary connection that never touches W). */
export async function readWorkingStateCopy(workingPath: string, stagingDir: string, host: StagingHost): Promise<SyncState> {
  const copy = await stageWithWal(workingPath, stagingDir, host);
  try {
    const db = new Database(copy, { fileMustExist: true });
    try {
      return loadFile(db).state;
    } finally {
      db.close();
    }
  } finally {
    await removeStagedCopy(copy, host);
  }
}

export type PrivateFileProblem =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'foreign-newer'; readonly syncFormat: number }
  | { readonly kind: 'foreign-other' };

export type PrivateFileRead =
  | { readonly kind: 'ok'; readonly lineageId: string; readonly meta: FileKeyMeta }
  | { readonly kind: 'problem'; readonly problem: PrivateFileProblem };

/** 3.2 private vault: lineage (sync_state.lineage_id, else from the salt) and vault_meta key fields. */
export async function readPrivateVaultFile(vaultPath: string, stagingDir: string, host: StagingHost): Promise<PrivateFileRead> {
  if ((await host.fs.stat(vaultPath)) === null) return { kind: 'problem', problem: { kind: 'missing' } };
  const copy = await stageWithWal(vaultPath, stagingDir, host);
  try {
    return inspectCopy(copy, host);
  } finally {
    await removeStagedCopy(copy, host);
  }
}

function inspectCopy(copy: string, host: StagingHost): PrivateFileRead {
  let db: Database.Database;
  try {
    db = new Database(copy, { fileMustExist: true });
  } catch (err) {
    host.logger.warn(`${SESSION_LOG_PREFIX} open: private vault copy did not open`, { code: errCode(err) });
    return unreadable('open-failed');
  }
  try {
    return inspectDb(db);
  } catch (err) {
    host.logger.warn(`${SESSION_LOG_PREFIX} open: private vault copy is unreadable`, { code: errCode(err) });
    return unreadable('open-failed');
  } finally {
    db.close();
  }
}

function inspectDb(db: Database.Database): PrivateFileRead {
  if (!hasContentTables(db)) return { kind: 'problem', problem: { kind: 'foreign-other' } };
  const format = readSyncFormat(db);
  if (format !== null && format > SYNC_FORMAT) return { kind: 'problem', problem: { kind: 'foreign-newer', syncFormat: format } };
  const meta = readKeyMeta(db);
  if (meta.salt === null && meta.verification === null) return { kind: 'problem', problem: { kind: 'foreign-other' } };
  if (meta.salt === null || meta.verification === null) return unreadable('missing-key-meta');
  const lineageId = format !== null && hasSyncTables(db) ? readLineage(db) : lineageIdFromSalt(meta.salt);
  if (lineageId === null) return unreadable('corrupt-sync-state');
  return { kind: 'ok', lineageId, meta };
}

function readKeyMeta(db: Database.Database): FileKeyMeta {
  const get = db.prepare('SELECT value FROM vault_meta WHERE key = ?');
  return { salt: textOrNull(get.get('salt')), verification: textOrNull(get.get('verification')) };
}

function readLineage(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get('lineage_id');
  const v = textOrNull(row);
  return v !== null && isLineageId(v) ? v : null;
}

function textOrNull(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const v = (row as { value?: unknown }).value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function unreadable(reason: string): PrivateFileRead {
  return { kind: 'problem', problem: { kind: 'unreadable', reason } };
}

export function errCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'unknown';
}
