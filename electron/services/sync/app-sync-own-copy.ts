/**
 * "Make my own copy" after a not-owner refusal (docs/PLAN_ENFORCEMENT.md 4.5): forks this
 * device's working copy W when it exists (it holds every change made here, including edits that
 * never reached the shared file), else the shared file, into a new lineage at the path the user
 * picked. W is closed at this point (the acquire runs before W opens), so a VACUUM INTO snapshot
 * of it is taken first. Neither source is changed. The ticket's key is zeroed afterwards.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { OwnCopyTicket, OwnCopyTickets } from '../vault-session/own-copy-tickets.js';
import { forkAsSeparateVault, type ForkHost } from './file-binding.js';
import { lineagePaths } from './paths.js';
import { vacuumInto } from './shared-file.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type * as Dto from './app-sync-dto.js';

export const OWN_COPY_EXPIRED_MESSAGE = 'Unlock the vault again to make your copy.';
export const OWN_COPY_UNREADABLE_MESSAGE = 'Could not read the vault file. Check the folder and try again.';

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

/** A VACUUM INTO snapshot of the closed working copy; null when it does not exist. */
async function snapshotWorking(ticket: OwnCopyTicket, lineageId: string, deps: OwnCopyDeps): Promise<string | null> {
  const working = lineagePaths(deps.machineDir, lineageId).working;
  if ((await deps.host.fs.stat(working)) === null) return null;
  await deps.host.fs.mkdir(deps.workDir);
  const target = path.join(deps.workDir, `own-copy-${deps.host.random.bytes(8).toString('hex')}.conduit`);
  const db = new Database(working, { fileMustExist: true, readonly: true });
  try {
    vacuumInto(db, target, deps.host.logger);
  } finally {
    db.close();
  }
  deps.host.logger.info(`${SYNC_LOG_PREFIX} own copy: snapshot of the working copy taken`, { lineageId: ticket.lineageId });
  return target;
}

async function removeQuietly(p: string, deps: OwnCopyDeps): Promise<void> {
  try {
    await deps.host.fs.rm(p, { recursive: false, force: true });
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} own copy: removing the snapshot failed`, { code: errCode(err) });
  }
}

async function readableSource(ticket: OwnCopyTicket, deps: OwnCopyDeps): Promise<{ readonly path: string; readonly scratch: boolean }> {
  try {
    if (ticket.source.kind === 'working') {
      const snap = await snapshotWorking(ticket, ticket.source.lineageId, deps);
      if (snap !== null) return { path: snap, scratch: true };
      throw new OwnCopyError(OWN_COPY_UNREADABLE_MESSAGE);
    }
    if ((await deps.host.fs.stat(ticket.source.path)) === null) throw new OwnCopyError(OWN_COPY_UNREADABLE_MESSAGE);
    return { path: ticket.source.path, scratch: false };
  } catch (err) {
    if (err instanceof OwnCopyError) throw err;
    deps.host.logger.error(`${SYNC_LOG_PREFIX} own copy: the source could not be read`, { code: errCode(err) });
    throw new OwnCopyError(OWN_COPY_UNREADABLE_MESSAGE);
  }
}

/** sync_make_own_copy: the ticket is used up whatever happens; its key is zeroed. */
export async function makeOwnCopy(ticketId: string, targetPath: string, deps: OwnCopyDeps): Promise<Dto.ForkResultDto> {
  const ticket = deps.tickets.take(ticketId, deps.host.clock.now());
  if (ticket === null) throw new OwnCopyError(OWN_COPY_EXPIRED_MESSAGE);
  try {
    const source = await readableSource(ticket, deps);
    try {
      const forked = await forkAsSeparateVault({ sourcePath: source.path, key: ticket.key, targetPath, workDir: deps.workDir }, deps.host);
      deps.host.logger.info(`${SYNC_LOG_PREFIX} own copy made`, { from: ticket.source.kind, file: path.basename(targetPath) });
      return { path: forked.path, lineageId: forked.lineageId };
    } finally {
      if (source.scratch) await removeQuietly(source.path, deps);
    }
  } finally {
    ticket.key.fill(0);
  }
}
