/**
 * After a master-password change on this device (spec 4.8): the private copies kept beside W are
 * still under the old password. Snapshot diffs move to the new epoch and their copies of W go,
 * so undo keeps working (5.10); genesis.conduit, quarantine/ and the staged copies of S in
 * incoming/ are removed. S stays under the old password until the next publish, and the cycle
 * before that publish stages it again, so incoming/ is emptied once more after the publish.
 * W, local.json and S are never removed. The password change has already committed, so every
 * step only logs its failure.
 */

import path from 'node:path';
import { clearFolder } from './housekeeping-files.js';
import type { SyncEngineDeps } from './sync-engine-types.js';
import { SYNC_LOG_PREFIX } from './host.js';

type CopiesDeps = Pick<SyncEngineDeps, 'replica' | 'snapshots' | 'host'>;

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

async function removeGenesis(deps: CopiesDeps): Promise<void> {
  const file = deps.replica.paths.genesis;
  try {
    await deps.host.fs.rm(file, { recursive: false, force: true });
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not remove ${path.basename(file)} after a password change`, { code: errCode(err) });
  }
}

/** Every staged copy of S or of a scanned copy; the next read stages S again. */
export function dropStagedCopies(deps: CopiesDeps): Promise<number> {
  return clearFolder(deps.replica.paths.incoming, deps.host);
}

function markDropAfterPublish(deps: CopiesDeps): void {
  try {
    deps.replica.updateLocal((l) => (l.dropStagedAfterPublish === true ? l : { ...l, dropStagedAfterPublish: true }));
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not note that staged copies go after the next publish`, { code: errCode(err) });
  }
}

/** Runs right after replica.changePassword committed, in the engine's lane. Never throws. */
export async function sealLocalCopies(deps: CopiesDeps): Promise<void> {
  const { replica, snapshots, host } = deps;
  markDropAfterPublish(deps);
  const report = await snapshots.rekey(replica.ring());
  await removeGenesis(deps);
  const quarantined = await clearFolder(replica.paths.quarantine, host);
  const staged = await dropStagedCopies(deps);
  host.logger.info(`${SYNC_LOG_PREFIX} local copies moved off the old password`, { ...report, quarantined, staged });
}

/** After a publish: the staged copies of the pre-change S go (4.8), once per password change. Never throws. */
export async function afterPublishSeal(deps: CopiesDeps): Promise<void> {
  if (deps.replica.local().dropStagedAfterPublish !== true) return;
  await dropStagedCopies(deps);
  try {
    deps.replica.updateLocal((l) => ({ ...l, dropStagedAfterPublish: false }));
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not clear the staged-copies note after a publish`, { code: errCode(err) });
  }
}
