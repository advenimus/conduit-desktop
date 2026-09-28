/**
 * Start-up cleanup of private scratch folders (spec 5.2 quarantine, 5.3 step 2, 12 fault
 * injection: kill -9 during a publish, ENOSPC): leftovers in a lineage's tmp/ (VACUUM INTO
 * snapshots, baseline and pre-sync copies, review copies) and the open's {syncRoot}/tmp peek
 * copies are removed once they are an hour old; quarantine/ keeps the newest few for 30 days.
 * Every step only logs its failures (the next start tries again).
 */

import path from 'node:path';
import { isErrno } from './paths.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';

/** Far longer than any publish, staging or review copy lives; the lane is idle at start anyway. */
export const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
/** Quarantined copies of torn shared files: the newest few, for 30 days (like snapshots). */
export const QUARANTINE_KEEP = 5;
export const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type FilesHost = Pick<SyncHost, 'fs' | 'logger'>;

interface Entry {
  readonly name: string;
  readonly mtimeMs: number;
}

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

async function entries(dir: string, host: FilesHost): Promise<Entry[]> {
  let names: string[];
  try {
    names = await host.fs.readdir(dir);
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return [];
    host.logger.warn(`${SYNC_LOG_PREFIX} could not list a scratch folder`, { folder: path.basename(dir), code: errCode(err) });
    throw err;
  }
  const out: Entry[] = [];
  for (const name of names) {
    const st = await host.fs.stat(path.join(dir, name));
    if (st !== null) out.push({ name, mtimeMs: st.mtimeMs });
  }
  return out;
}

async function removeAll(dir: string, names: readonly string[], host: FilesHost): Promise<number> {
  let removed = 0;
  for (const name of names) {
    try {
      await host.fs.rm(path.join(dir, name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a leftover scratch file`, { file: name, code: errCode(err) });
    }
  }
  return removed;
}

/** Removes everything in `dir` older than SCRATCH_MAX_AGE_MS; returns the count. */
export async function cleanupScratch(dir: string, nowMs: number, host: FilesHost): Promise<number> {
  const old = (await entries(dir, host)).filter((e) => nowMs - e.mtimeMs > SCRATCH_MAX_AGE_MS).map((e) => e.name);
  const removed = await removeAll(dir, old, host);
  if (removed > 0) host.logger.info(`${SYNC_LOG_PREFIX} removed leftover scratch files`, { folder: path.basename(dir), removed });
  return removed;
}

/** Keeps the QUARANTINE_KEEP newest quarantined copies younger than QUARANTINE_MAX_AGE_MS; returns the removed count. */
export async function pruneQuarantine(dir: string, nowMs: number, host: FilesHost): Promise<number> {
  const newestFirst = (await entries(dir, host)).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  const drop = newestFirst.filter((e, i) => i >= QUARANTINE_KEEP || nowMs - e.mtimeMs > QUARANTINE_MAX_AGE_MS).map((e) => e.name);
  return removeAll(dir, drop, host);
}
