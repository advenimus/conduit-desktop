/**
 * Publishing W to S (spec 5.3): VACUUM INTO on W's connection, the CAS re-read of S, the temp
 * next to S with fsync and the mtime bump, rename over S with EPERM/EBUSY retries and the
 * in-place fallback, directory fsync, and removal of leftover publish temps.
 * Import through shared-file.ts.
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { markWalJournalMode } from '../vault/wal-header.js';
import { isPublishTempName, publishTempName } from './paths.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';
import { errnoCodeOf, errorMessageOf, listDir, removeQuietly, sha256Hex } from './shared-file-read.js';
import {
  PUBLISH_MTIME_BUMP_MS,
  PUBLISH_RETRY_CODES,
  PUBLISH_RETRY_DELAYS_MS,
  PUBLISH_TEMP_MAX_AGE_MS,
  type PublishInput,
  type PublishOutcome,
  type SharedFileHost,
} from './shared-file-types.js';

const TEMP_RAND_BYTES = 6;
const SHA8 = 8;
const VACUUM_OUTPUT_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const;

/**
 * VACUUM INTO `target` on W's connection (outside any transaction); target must not exist. A
 * VACUUM INTO that fails (SQLITE_FULL, IOERR) leaves its partial output behind: removed here.
 * The output is switched to WAL mode so older apps can open it (see wal-header.ts).
 */
export function vacuumInto(db: Database.Database, target: string, logger: SyncLogger): void {
  if (db.inTransaction) throw new Error(`${SYNC_LOG_PREFIX} VACUUM INTO must run outside a transaction`);
  const existed = fs.existsSync(target);
  try {
    db.prepare('VACUUM INTO ?').run(target);
    markWalJournalMode(target);
  } catch (err) {
    logger.error(`${SYNC_LOG_PREFIX} VACUUM INTO failed`, { code: errnoCodeOf(err), file: path.basename(target) });
    if (!existed) removePartialOutput(target, logger);
    throw err;
  }
}

function removePartialOutput(target: string, logger: SyncLogger): void {
  for (const suffix of VACUUM_OUTPUT_SUFFIXES) {
    try {
      fs.rmSync(`${target}${suffix}`, { force: true });
    } catch (err) {
      // The start-up tmp/ cleanup removes it later; the VACUUM error is what the caller reports.
      logger.warn(`${SYNC_LOG_PREFIX} could not remove a failed VACUUM INTO output`, { code: errnoCodeOf(err) });
    }
  }
}

class PublishIoError extends Error {
  constructor(
    readonly step: string,
    readonly ioError: unknown,
  ) {
    super(`${step}: ${errorMessageOf(ioError)}`);
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new PublishIoError(name, err);
  }
}

type Changed = Extract<PublishOutcome, { kind: 'changed' }>;

/** CAS against the S that was merged: null means go ahead. */
async function casCheck(input: PublishInput, host: SharedFileHost): Promise<Changed | null> {
  if (input.expectedSha256 === null) {
    const st = await step('stat', () => host.fs.stat(input.sharedPath));
    if (st === null) return null;
    const current = await step('read', () => host.fs.readFile(input.sharedPath));
    return { kind: 'changed', currentSha256: sha256Hex(current) };
  }
  let current: Buffer;
  try {
    current = await host.fs.readFile(input.sharedPath);
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'changed', currentSha256: null };
    throw new PublishIoError('read', err);
  }
  const sha = sha256Hex(current);
  return sha === input.expectedSha256 ? null : { kind: 'changed', currentSha256: sha };
}

/** 5.3 step 4: max(now, observed + 2 s), so older apps comparing mtimes with `>` see the file. */
export function publishMtime(nowMs: number, observedMtimeMs: number | null): number {
  return observedMtimeMs === null ? nowMs : Math.max(nowMs, Math.ceil(observedMtimeMs + PUBLISH_MTIME_BUMP_MS));
}

interface Placement {
  readonly temp: string;
  readonly bytes: Buffer;
  readonly nowMs: number;
  readonly mtimeMs: number;
}

type Placed = { readonly kind: 'placed'; readonly inPlace: boolean } | Changed;

/**
 * rename(temp, S) with the retry schedule; after the last EPERM/EBUSY, S is written in place.
 * A refused rename usually means another writer (the cloud client, an older app) has S open
 * right now, so the CAS is repeated after every wait and before the in-place write.
 */
async function placeOverShared(input: PublishInput, p: Placement, host: SharedFileHost): Promise<Placed> {
  for (let attempt = 0; ; attempt++) {
    try {
      await host.fs.rename(p.temp, input.sharedPath);
      return { kind: 'placed', inPlace: false };
    } catch (err) {
      const code = errnoCodeOf(err);
      if (code === null || !PUBLISH_RETRY_CODES.has(code)) throw new PublishIoError('rename', err);
      const delay = PUBLISH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      host.logger.warn(`${SYNC_LOG_PREFIX} publish rename refused; retrying`, { code, attempt: attempt + 1, delayMs: delay });
      await host.timers.sleep(delay);
      const cas = await casCheck(input, host);
      if (cas !== null) return cas;
    }
  }
  const cas = await casCheck(input, host);
  if (cas !== null) return cas;
  host.logger.warn(`${SYNC_LOG_PREFIX} publish rename kept failing; writing the shared file in place`);
  await step('write-in-place', () => host.fs.writeFileDurable(input.sharedPath, p.bytes));
  await step('utimes-in-place', () => host.fs.utimes(input.sharedPath, p.nowMs, p.mtimeMs));
  await removeQuietly(p.temp, host);
  return { kind: 'placed', inPlace: true };
}

/**
 * The rename replaces S with the temp, so the temp takes S's permission bits (a vault the user
 * locked down stays locked down). A first publish gets the owner-only default.
 */
async function sharedFileMode(sharedPath: string, host: SharedFileHost): Promise<number | undefined> {
  try {
    return (await host.fs.stat(sharedPath))?.mode;
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} could not read the shared file's permissions; the new file is owner-only`, { code: errnoCodeOf(err) });
    return undefined;
  }
}

/** The CAS read comes after the slow temp write, so only one read and the rename remain unprotected. */
async function publishSteps(input: PublishInput, host: SharedFileHost, temps: string[]): Promise<PublishOutcome> {
  const bytes = await step('read-snapshot', () => host.fs.readFile(input.snapshotPath));
  const sha256 = sha256Hex(bytes);
  const dir = path.dirname(input.sharedPath);
  const rand = host.random.bytes(TEMP_RAND_BYTES).toString('hex');
  const temp = path.join(dir, publishTempName(path.basename(input.sharedPath), rand));
  temps.push(temp);
  const mode = await sharedFileMode(input.sharedPath, host);
  await step('write-temp', () => host.fs.writeFileDurable(temp, bytes, mode));
  const nowMs = host.clock.now();
  const mtimeMs = publishMtime(nowMs, input.observedMtimeMs);
  await step('utimes', () => host.fs.utimes(temp, nowMs, mtimeMs));
  const cas = await casCheck(input, host);
  const placed = cas ?? (await placeOverShared(input, { temp, bytes, nowMs, mtimeMs }, host));
  if (placed.kind === 'changed') {
    await removeQuietly(temp, host);
    host.logger.info(`${SYNC_LOG_PREFIX} the shared file changed before our publish landed; merging again`);
    return placed;
  }
  host.logger.info(`${SYNC_LOG_PREFIX} published the shared file`, { sha8: sha256.slice(0, SHA8), inPlace: placed.inPlace });
  return { kind: 'published', sha256, mtimeMs: await settle(dir, input.sharedPath, mtimeMs, host), inPlace: placed.inPlace };
}

/**
 * After S was replaced: fsync the folder and read back the mtime. S already holds the new
 * bytes, so a failure here is logged and the publish still counts (the next read verifies it).
 */
async function settle(dir: string, sharedPath: string, mtimeMs: number, host: SharedFileHost): Promise<number> {
  try {
    await host.fs.fsyncDir(dir);
    return (await host.fs.stat(sharedPath))?.mtimeMs ?? mtimeMs;
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} folder sync after publishing failed`, { code: errnoCodeOf(err) });
    return mtimeMs;
  }
}

/**
 * 5.3 steps 3-5: copy the snapshot to `<dir>/.~<name>.<rand>.tmp` (paths.publishTempName),
 * fsync, utimes to max(now, observed + PUBLISH_MTIME_BUMP_MS), CAS re-read of S, rename over
 * S, fsyncDir. EPERM/EBUSY on the rename: CAS again after each wait of PUBLISH_RETRY_DELAYS_MS,
 * then CAS and write S in place (durable) with the same mtime rule. Never throws for IO errors: 'failed'.
 */
export async function publishIfUnchanged(input: PublishInput, host: SharedFileHost): Promise<PublishOutcome> {
  const temps: string[] = [];
  try {
    return await publishSteps(input, host, temps);
  } catch (err) {
    if (!(err instanceof PublishIoError)) throw err;
    const code = errnoCodeOf(err.ioError);
    host.logger.error(`${SYNC_LOG_PREFIX} publish failed`, { step: err.step, code });
    for (const temp of temps) await removeQuietly(temp, host);
    return { kind: 'failed', code, message: err.message };
  } finally {
    await removeQuietly(input.snapshotPath, host);
  }
}

/** 5.3 step 6: removes `.~<name>.*.tmp` files older than PUBLISH_TEMP_MAX_AGE_MS; returns the count. */
export async function cleanupPublishTemps(sharedDir: string, nowMs: number, host: SharedFileHost): Promise<number> {
  const names = await listDir(sharedDir, host);
  if (names === null) return 0;
  let removed = 0;
  for (const name of names) {
    if (!isPublishTempName(name)) continue;
    const file = path.join(sharedDir, name);
    try {
      const st = await host.fs.stat(file);
      if (st === null || !st.isFile || nowMs - st.mtimeMs <= PUBLISH_TEMP_MAX_AGE_MS) continue;
      await host.fs.rm(file, { recursive: false, force: true });
      removed++;
    } catch (err) {
      host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a leftover publish temp`, { file: name, code: errnoCodeOf(err) });
    }
  }
  return removed;
}
