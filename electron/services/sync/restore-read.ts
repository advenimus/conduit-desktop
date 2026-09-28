/**
 * Reading a backup file for [Roll this vault back] (spec 5.10): a private staged copy, its
 * content tables, and its own keys when the password opens its verification token. Only the
 * content matters; a backup's sync tables (if any) are never merged. Import through restore.ts.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { SYNC_LOG_PREFIX, type SyncHost, type SyncLogger } from './host.js';
import { deriveEpochKeys, lineageIdFromSalt } from './hashing.js';
import { verifyKey } from './key-epoch.js';
import { SYNC_STATE_KEYS, hasContentTables, hasSyncTables } from './schema.js';
import { loadContent } from './state-store.js';
import type { BackupContent } from './restore-types.js';
import type { ContentSnapshot, EpochKeys } from './types.js';

const STAGE_PREFIX = 'restore-';
const STAGE_SUFFIX = '.conduit';
const STAGE_RANDOM_BYTES = 8;
/** SQLite may leave these next to the staged copy after opening it. */
const SQLITE_SIDE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
const QUICK_CHECK_OK = 'ok';

type ReadHost = Pick<SyncHost, 'fs' | 'random' | 'logger'>;

interface StagedRead {
  readonly content: ContentSnapshot;
  /** sync_state.lineage_id when the backup is a synced file. */
  readonly lineageId: string | null;
}

/**
 * Reads a backup file (pre-sync or synced; only its content matters) from a private staged copy
 * under `workDir`; derives its keys with `deriveFromSalt` when its verification token opens.
 */
export async function readBackupContent(
  backupPath: string,
  workDir: string,
  deriveFromSalt: (saltB64: string) => Buffer,
  host: ReadHost,
): Promise<BackupContent> {
  await host.fs.mkdir(workDir);
  const staged = path.join(workDir, `${STAGE_PREFIX}${host.random.bytes(STAGE_RANDOM_BYTES).toString('hex')}${STAGE_SUFFIX}`);
  try {
    await host.fs.copyFile(backupPath, staged);
    const read = readStaged(staged);
    return { content: read.content, keys: backupKeys(read, deriveFromSalt, host.logger) };
  } catch (err) {
    host.logger.error(`${SYNC_LOG_PREFIX} backup read failed`, { file: path.basename(backupPath), code: errorCode(err) });
    throw err;
  } finally {
    await removeStaged(staged, host);
  }
}

function readStaged(staged: string): StagedRead {
  const db = new Database(staged, { fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== QUICK_CHECK_OK) {
      throw new Error(`${SYNC_LOG_PREFIX} backup file is damaged`);
    }
    if (!hasContentTables(db)) throw new Error(`${SYNC_LOG_PREFIX} backup is not a Conduit vault`);
    return { content: loadContent(db), lineageId: hasSyncTables(db) ? syncLineage(db) : null };
  } finally {
    db.close();
  }
}

function syncLineage(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(SYNC_STATE_KEYS.lineageId) as { value: unknown } | undefined;
  return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null;
}

/** The backup's own epoch keys when the password opens its verification token. */
function backupKeys(read: StagedRead, deriveFromSalt: (saltB64: string) => Buffer, logger: SyncLogger): EpochKeys | null {
  const salt = read.content.meta.get('salt');
  const verification = read.content.meta.get('verification');
  if (!salt || !verification) {
    logger.warn(`${SYNC_LOG_PREFIX} backup has no password check; its secrets are read with the vault's keys only`);
    return null;
  }
  const key = deriveFromSalt(salt);
  if (!verifyKey(key, verification)) {
    logger.info(`${SYNC_LOG_PREFIX} backup uses another password; its secrets are read with the vault's keys only`);
    return null;
  }
  return deriveEpochKeys(key, read.lineageId ?? lineageIdFromSalt(salt));
}

async function removeStaged(staged: string, host: ReadHost): Promise<void> {
  for (const suffix of SQLITE_SIDE_SUFFIXES) {
    try {
      await host.fs.rm(staged + suffix, { recursive: false, force: true });
    } catch (err) {
      host.logger.error(`${SYNC_LOG_PREFIX} staged backup copy not removed`, { file: path.basename(staged + suffix), code: errorCode(err) });
    }
  }
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.name : 'unknown';
}
