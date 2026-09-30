/**
 * "Make my own copy" after a not-owner refusal (docs/PLAN_ENFORCEMENT.md 4.5): forks this
 * device's working copy W when it exists and a ticket key opens it (it holds every change made
 * here, including edits that never reached the shared file), else the shared file, into a new
 * lineage at the path the user picked. W can be one key epoch behind S (the password was changed
 * on another device), so the ticket carries the accepted key and W's previous-epoch key; when
 * neither opens W, S is forked with the key that opens it. W is closed at this point (the acquire
 * runs before W opens), so a VACUUM INTO snapshot of it is taken first. Neither source is changed.
 * The ticket is used up only when the copy is made; a failure keeps it for another try.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { OwnCopyTicket, OwnCopyTickets } from '../vault-session/own-copy-tickets.js';
import { forkAsSeparateVault, type ForkHost } from './file-binding.js';
import { verifyKey } from './key-epoch.js';
import { lineagePaths } from './paths.js';
import { vacuumInto } from './shared-file.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type * as Dto from './app-sync-dto.js';

export const OWN_COPY_EXPIRED_MESSAGE = 'Unlock the vault again to make your copy.';
export const OWN_COPY_UNREADABLE_MESSAGE = 'Could not read the vault file. Check the folder and try again.';

const VERIFICATION_META_KEY = 'verification';

export interface OwnCopyDeps {
  readonly tickets: OwnCopyTickets;
  readonly machineDir: string;
  /** {syncRoot}/tmp. */
  readonly workDir: string;
  readonly host: ForkHost;
}

export class OwnCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnCopyError';
  }
}

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** A VACUUM INTO snapshot of the closed working copy; null when it does not exist or cannot be read. */
async function snapshotWorking(lineageId: string, deps: OwnCopyDeps): Promise<string | null> {
  try {
    const working = lineagePaths(deps.machineDir, lineageId).working;
    if ((await deps.host.fs.stat(working)) === null) return null;
    await deps.host.fs.mkdir(deps.workDir);
    const target = scratchPath(deps);
    const db = new Database(working, { fileMustExist: true, readonly: true });
    try {
      vacuumInto(db, target, deps.host.logger);
    } finally {
      db.close();
    }
    deps.host.logger.info(`${SYNC_LOG_PREFIX} own copy: snapshot of the working copy taken`, { lineageId });
    return target;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} own copy: the working copy could not be read; using the shared file`, { code: errCode(err) });
    return null;
  }
}

/** The first ticket key that opens the scratch file's vault_meta verification token; null when none does or it cannot be read. */
function keyThatOpens(file: string, keys: readonly Buffer[], deps: OwnCopyDeps): Buffer | null {
  try {
    const db = new Database(file, { fileMustExist: true });
    try {
      const row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(VERIFICATION_META_KEY) as { value?: unknown } | undefined;
      const verification = typeof row?.value === 'string' ? row.value : null;
      if (verification === null) return null;
      return keys.find((k) => verifyKey(k, verification)) ?? null;
    } finally {
      db.close();
    }
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} own copy: the key check could not read the file`, { code: errCode(err) });
    return null;
  }
}

async function removeScratch(p: string, deps: OwnCopyDeps): Promise<void> {
  for (const file of [p, `${p}-journal`, `${p}-wal`, `${p}-shm`]) {
    try {
      await deps.host.fs.rm(file, { recursive: false, force: true });
    } catch (err) {
      deps.host.logger.warn(`${SYNC_LOG_PREFIX} own copy: removing the snapshot failed`, { code: errCode(err) });
    }
  }
}

function scratchPath(deps: OwnCopyDeps): string {
  return path.join(deps.workDir, `own-copy-${deps.host.random.bytes(8).toString('hex')}.conduit`);
}

async function forkFile(sourcePath: string, key: Buffer, targetPath: string, deps: OwnCopyDeps): Promise<Dto.ForkResultDto> {
  const forked = await forkAsSeparateVault({ sourcePath, key, targetPath, workDir: deps.workDir }, deps.host);
  return { path: forked.path, lineageId: forked.lineageId };
}

/** W's snapshot when a ticket key opens it; null means "use the shared file". */
async function forkWorking(ticket: OwnCopyTicket, lineageId: string, targetPath: string, deps: OwnCopyDeps): Promise<Dto.ForkResultDto | null> {
  const snap = await snapshotWorking(lineageId, deps);
  if (snap === null) return null;
  try {
    const key = keyThatOpens(snap, ticket.keys, deps);
    if (key === null) {
      deps.host.logger.warn(`${SYNC_LOG_PREFIX} own copy: no key opens the working copy (another key epoch); using the shared file`, { lineageId });
      return null;
    }
    return await forkFile(snap, key, targetPath, deps);
  } finally {
    await removeScratch(snap, deps);
  }
}

/** A private copy of S in workDir: opening S itself could leave SQLite side files in the shared folder. */
async function copyShared(sharedPath: string, deps: OwnCopyDeps): Promise<string> {
  const probe = scratchPath(deps);
  try {
    if ((await deps.host.fs.stat(sharedPath)) === null) throw new OwnCopyError(OWN_COPY_UNREADABLE_MESSAGE);
    await deps.host.fs.mkdir(deps.workDir);
    await deps.host.fs.copyFile(sharedPath, probe);
    return probe;
  } catch (err) {
    await removeScratch(probe, deps);
    if (err instanceof OwnCopyError) throw err;
    deps.host.logger.error(`${SYNC_LOG_PREFIX} own copy: the source could not be read`, { code: errCode(err) });
    throw new OwnCopyError(OWN_COPY_UNREADABLE_MESSAGE);
  }
}

async function forkShared(ticket: OwnCopyTicket, sharedPath: string, targetPath: string, deps: OwnCopyDeps): Promise<Dto.ForkResultDto> {
  const probe = await copyShared(sharedPath, deps);
  try {
    const key = keyThatOpens(probe, ticket.keys, deps) ?? ticket.keys[0];
    if (key === undefined) throw new OwnCopyError(OWN_COPY_EXPIRED_MESSAGE);
    return await forkFile(probe, key, targetPath, deps);
  } finally {
    await removeScratch(probe, deps);
  }
}

/** sync_make_own_copy: the ticket is zeroed and used up once the copy exists; a failure keeps it. */
export async function makeOwnCopy(ticketId: string, targetPath: string, deps: OwnCopyDeps): Promise<Dto.ForkResultDto> {
  const ticket = deps.tickets.get(ticketId, deps.host.clock.now());
  if (ticket === null) throw new OwnCopyError(OWN_COPY_EXPIRED_MESSAGE);
  const src = ticket.source;
  const made =
    (src.kind === 'working' ? await forkWorking(ticket, src.lineageId, targetPath, deps) : null) ??
    (await forkShared(ticket, src.kind === 'working' ? src.sharedPath : src.path, targetPath, deps));
  deps.tickets.consume(ticketId);
  deps.host.logger.info(`${SYNC_LOG_PREFIX} own copy made`, { from: src.kind, file: path.basename(targetPath) });
  return made;
}
