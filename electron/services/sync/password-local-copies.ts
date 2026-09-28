/**
 * After W moves to a new key epoch (spec 4.8: a password change on this device, or adopting one
 * made elsewhere), the private copies kept beside W are still under the old password. Snapshot
 * diffs move to the new epoch and their copies of W go, so undo keeps working (5.10); pending
 * candidates are re-encrypted (rows) or sealed under the new key (files), and a candidate no key
 * opens any more is dropped with a notice (4.9); genesis.conduit, quarantine/, sidefiles-<ts>/
 * and the staged copies in incoming/ are removed. S stays under the old password until the next
 * publish and the cycle before it stages S again, so incoming/ is emptied once more after that
 * publish. W, local.json and S are never removed.
 *
 * local.json `sealLocalCopiesPending` is set with the epoch change and cleared only when every
 * step succeeded, so an adoption at unlock (no engine yet), a crash or a failed step is finished
 * by the engine at its next start. Every step only logs its failure: the epoch change stands.
 */

import path from 'node:path';
import { clearFolder } from './housekeeping-files.js';
import { isSideFilesDirName } from './paths.js';
import type { ReplicaPort } from './replica.js';
import type { SyncEngineDeps } from './sync-engine-types.js';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';

export type SealDeps = Pick<SyncEngineDeps, 'replica' | 'snapshots' | 'candidates' | 'notices' | 'status' | 'host'>;
type StagedDeps = Pick<SyncEngineDeps, 'replica' | 'host'>;

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function updateFlag(replica: Pick<ReplicaPort, 'updateLocal'>, logger: SyncLogger, what: string, set: boolean): boolean {
  try {
    replica.updateLocal((l) => ((l.sealLocalCopiesPending ?? false) === set ? l : { ...l, sealLocalCopiesPending: set }));
    return true;
  } catch (err) {
    logger.warn(`${SYNC_LOG_PREFIX} could not ${what}`, { code: errCode(err) });
    return false;
  }
}

/** Right after a commit that moved W to a new epoch. Never throws. */
export function markLocalCopiesStale(replica: Pick<ReplicaPort, 'updateLocal'>, logger: SyncLogger): void {
  updateFlag(replica, logger, 'note that local copies still use the old password', true);
}

async function removeGenesis(deps: SealDeps): Promise<number> {
  const file = deps.replica.paths.genesis;
  try {
    await deps.host.fs.rm(file, { recursive: false, force: true });
    return 0;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not remove ${path.basename(file)} after a password change`, { code: errCode(err) });
    return 1;
  }
}

/** Candidates re-keyed or sealed; the ones no key opens are dropped with a notice and their prompt. */
async function sealCandidates(deps: SealDeps): Promise<number> {
  const { candidates, notices, status, host, replica } = deps;
  try {
    await candidates.ensureLoaded();
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} pending candidates could not be loaded to move them off the old password`, { code: errCode(err) });
    return 1;
  }
  const report = await candidates.rekey(replica.ring());
  for (const c of report.dropped) {
    status.clearPrompt(`candidate:${c.id}`);
    notices.add({ kind: 'candidate-dropped', key: null, sourceSha256: c.payload.kind === 'file' ? c.payload.sha256 : null, count: 1 });
  }
  return report.failed;
}

function markDropAfterPublish(deps: StagedDeps): number {
  try {
    deps.replica.updateLocal((l) => (l.dropStagedAfterPublish === true ? l : { ...l, dropStagedAfterPublish: true }));
    return 0;
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not note that staged copies go after the next publish`, { code: errCode(err) });
    return 1;
  }
}

/** Every staged copy of S or of a scanned copy; the next read stages S again. */
export async function dropStagedCopies(deps: StagedDeps): Promise<number> {
  return (await clearFolder(deps.replica.paths.incoming, deps.host)).failed;
}

async function seal(deps: SealDeps): Promise<void> {
  const { replica, snapshots, host } = deps;
  const snaps = await snapshots.rekey(replica.ring());
  const failed =
    snaps.failed +
    (await sealCandidates(deps)) +
    (await removeGenesis(deps)) +
    (await clearFolder(replica.paths.quarantine, host)).failed +
    (await clearFolder(replica.paths.dir, host, isSideFilesDirName)).failed +
    markDropAfterPublish(deps) +
    (await dropStagedCopies(deps));
  host.logger.info(`${SYNC_LOG_PREFIX} local copies moved off the old password`, { snapshots: snaps.rekeyed, failed });
  if (failed === 0) updateFlag(replica, host.logger, 'clear the local copies note', false);
}

/** Engine start: finishes what an adoption at unlock, a crash or a failed step left due. Never throws. */
export async function sealIfPending(deps: SealDeps): Promise<void> {
  if (deps.replica.local().sealLocalCopiesPending === true) await seal(deps);
}

/** Right after an epoch change the engine ran (a password change here, or one adopted), in its lane. Never throws. */
export async function sealAfterEpochChange(deps: SealDeps): Promise<void> {
  markLocalCopiesStale(deps.replica, deps.host.logger);
  await seal(deps);
}

/** After a publish: the staged copies of the pre-change S go (4.8), once per epoch change. Never throws. */
export async function afterPublishSeal(deps: StagedDeps): Promise<void> {
  if (deps.replica.local().dropStagedAfterPublish !== true) return;
  if ((await dropStagedCopies(deps)) > 0) return;
  try {
    deps.replica.updateLocal((l) => ({ ...l, dropStagedAfterPublish: false }));
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not clear the staged-copies note after a publish`, { code: errCode(err) });
  }
}
