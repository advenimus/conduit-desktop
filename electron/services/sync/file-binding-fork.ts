/**
 * "Make a separate vault" (spec 5.9, 5.10 "Restore as a new vault", 12 row 20): a NEW file with
 * a new lineage, a random genesis and a new vault_id, written from a private copy of the chosen
 * state. The source is never modified and the target is never overwritten. The result opens
 * with the same password (same salt and verification). Import through file-binding.ts.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { markWalJournalMode } from '../vault/wal-header.js';
import { genesisFromContent } from './genesis.js';
import { deriveEpochKeys, makeImplicitProvider } from './hashing.js';
import { verifyKey } from './key-epoch.js';
import { materialize } from './materialize.js';
import { publishTempName } from './paths.js';
import { SYNC_FORMAT_KEY, SYNC_TABLES, ensureSyncSchema } from './schema.js';
import { loadContent, saveState } from './state-store.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { SyncCoreError, type ContentSnapshot } from './types.js';

export interface ForkInput {
  /** A SQLite file holding the chosen state's content: a VACUUM INTO of W, a copy, or a backup. */
  readonly sourcePath: string;
  /** Key of the source's current epoch (secrets stay under the same password). */
  readonly key: Buffer;
  /** Must not exist: forks never overwrite (the IPC layer's Save dialog picks a new path). */
  readonly targetPath: string;
  /** Private scratch folder (lineage tmp/). */
  readonly workDir: string;
}

export interface ForkResult {
  readonly path: string;
  readonly lineageId: string;
  readonly genesisId: string;
  readonly vaultId: string;
}

export type ForkHost = Pick<SyncHost, 'fs' | 'random' | 'clock' | 'logger'>;

interface ForkIds {
  readonly lineageId: string;
  readonly genesisId: string;
  readonly vaultId: string;
}

const GENESIS_ID_BYTES = 32;
const TEMP_RAND_BYTES = 6;
const VAULT_ID_META_KEY = 'vault_id';
const VERIFICATION_META_KEY = 'verification';
const FORK_PREFIX = 'fork-';
const VAULT_EXTENSION = '.conduit';

function errCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

function sqlQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function existsError(target: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${SYNC_LOG_PREFIX} fork: the target already exists: ${path.basename(target)}`);
  err.code = 'EEXIST';
  return err;
}

async function refuseExisting(target: string, host: ForkHost): Promise<void> {
  if ((await host.fs.stat(target)) !== null) throw existsError(target);
}

/** Every sync table and sync_format go; the copy becomes a pre-sync file with a new vault_id. */
function stripSyncState(db: Database.Database, vaultId: string): void {
  db.transaction(() => {
    for (const table of SYNC_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare('DELETE FROM vault_meta WHERE key = ?').run(SYNC_FORMAT_KEY);
    db.prepare('INSERT INTO vault_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      VAULT_ID_META_KEY,
      vaultId,
    );
  })();
}

function requireKeyOpens(content: ContentSnapshot, key: Buffer): void {
  const verification = content.meta.get(VERIFICATION_META_KEY);
  if (verification === undefined || !verifyKey(key, verification)) {
    throw new SyncCoreError('KEY_MISMATCH', 'fork: the key does not open the source vault');
  }
}

/** G1 genesis over the stripped copy, saved into it, then VACUUM INTO `out` (switched to WAL mode). */
function rebuildAsGenesis(work: string, out: string, key: Buffer, ids: ForkIds, host: ForkHost): void {
  const db = new Database(work, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    requireKeyOpens(loadContent(db), key);
    stripSyncState(db, ids.vaultId);
    ensureSyncSchema(db);
    const content = loadContent(db);
    const k0 = deriveEpochKeys(key, ids.lineageId);
    const g = genesisFromContent({
      content,
      genesisId: ids.genesisId,
      lineageId: ids.lineageId,
      k0,
      randomBytes: (n) => host.random.bytes(n),
      now: () => host.clock.now(),
    });
    const implicit = makeImplicitProvider(k0.kSync);
    const m = materialize(g.state, content, g.cache, { implicit, currentEpoch: g.state.epochs.get(k0.epochId) ?? null });
    saveState(db, { state: m.state, plan: m.plan, cache: m.cache, baseline: null });
    db.exec(`VACUUM INTO ${sqlQuote(out)}`);
  } finally {
    db.close();
  }
  markWalJournalMode(out);
}

/** tmp next to the target + fsync, then rename; the target is checked again right before the rename. */
async function writeNewFile(source: string, target: string, host: ForkHost): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, publishTempName(path.basename(target), host.random.bytes(TEMP_RAND_BYTES).toString('hex')));
  const bytes = await host.fs.readFile(source);
  try {
    await host.fs.writeFileDurable(tmp, bytes);
    await refuseExisting(target, host);
    await host.fs.rename(tmp, target);
  } catch (err) {
    await removeQuietly([tmp], host);
    throw err;
  }
  await host.fs.fsyncDir(dir);
}

async function removeQuietly(paths: readonly string[], host: ForkHost): Promise<void> {
  for (const p of paths) {
    try {
      await host.fs.rm(p, { recursive: false, force: true });
    } catch (err) {
      host.logger.warn(`${SYNC_LOG_PREFIX} fork: removing a scratch file failed`, { file: path.basename(p), code: errCode(err) });
    }
  }
}

/**
 * 5.9 "make a separate vault" and 5.10 "restore as a new vault": copy the source into workDir,
 * drop every sync_* table and sync_format, set a new vault_id, run G1 genesis over the content
 * with a random lineage (UUIDv4) and a random genesis_id (64 hex, not a hash of bytes), VACUUM
 * INTO a temp, then tmp + fsync + rename to targetPath. The source is never modified.
 */
export async function forkAsSeparateVault(input: ForkInput, host: ForkHost): Promise<ForkResult> {
  await refuseExisting(input.targetPath, host);
  await host.fs.mkdir(input.workDir);
  const rand = (): string => host.random.bytes(TEMP_RAND_BYTES).toString('hex');
  const work = path.join(input.workDir, `${FORK_PREFIX}${rand()}${VAULT_EXTENSION}`);
  const out = path.join(input.workDir, `${FORK_PREFIX}${rand()}-out${VAULT_EXTENSION}`);
  try {
    await host.fs.copyFile(input.sourcePath, work);
    const ids: ForkIds = {
      lineageId: host.random.uuid(),
      genesisId: host.random.bytes(GENESIS_ID_BYTES).toString('hex'),
      vaultId: host.random.uuid(),
    };
    rebuildAsGenesis(work, out, input.key, ids, host);
    await writeNewFile(out, input.targetPath, host);
    host.logger.info(`${SYNC_LOG_PREFIX} fork: wrote a separate vault`, { file: path.basename(input.targetPath) });
    return { path: input.targetPath, ...ids };
  } catch (err) {
    host.logger.error(`${SYNC_LOG_PREFIX} fork: making a separate vault failed`, { code: errCode(err), name: (err as Error).name });
    throw err;
  } finally {
    await removeQuietly([work, `${work}-journal`, `${work}-wal`, `${work}-shm`, out], host);
  }
}
