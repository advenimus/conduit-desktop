/**
 * Machine-folder lookups the app needs outside an open vault (spec 3.1 binding, 5.9 biometric
 * keyed by lineage, 5.11 engine-off warning and export): which lineage a vault path belongs to
 * (without its password), which lineages hold changes that exist only here, and an export of a
 * closed working copy. Read-only except the export file itself.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { realpathNearest } from '../vault-session/open-location.js';
import { readPrivateVaultFile } from '../vault-session/open-staging.js';
import { fileStem, EXPORT_SUFFIX, VAULT_EXT } from './sync-engine-actions.js';
import { lineagePaths } from './paths.js';
import { findBoundLineage, readPendingSummaries, type ReplicaDeps } from './replica.js';
import { vacuumInto } from './shared-file.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import type * as Dto from './app-sync-dto.js';

export const NO_UNSYNCED_CHANGES_MESSAGE = 'No unsynced changes were found for this vault.';

/** Export names tried (' 2', ' 3', ...) before giving up. */
const EXPORT_NAME_ATTEMPTS = 1000;

export interface LineageLookupDeps {
  readonly machineDir: string;
  /** {syncRoot}/tmp, the peek staging folder. */
  readonly stagingDir: string;
  readonly replicaDeps: ReplicaDeps;
  readonly host: SyncHost;
}

/** The same key bindings store at open (realpath of the nearest existing ancestor), even for a missing file. */
async function bindingRealpath(p: string, host: SyncHost): Promise<string> {
  try {
    return await realpathNearest(p, host.fs);
  } catch {
    return path.resolve(p);
  }
}

/** The lineage of a vault file: its binding here, else its own sync_state or salt. Null when unreadable. */
export async function lineageForPath(vaultPath: string, deps: LineageLookupDeps): Promise<string | null> {
  const real = await bindingRealpath(vaultPath, deps.host);
  const bound = await findBoundLineage(deps.machineDir, real, deps.replicaDeps);
  if (bound !== null) return bound;
  await deps.host.fs.mkdir(deps.stagingDir);
  const read = await readPrivateVaultFile(vaultPath, deps.stagingDir, deps.host);
  return read.kind === 'ok' ? read.lineageId : null;
}

export async function pendingVaults(deps: LineageLookupDeps): Promise<Dto.PendingVault[]> {
  const all = await readPendingSummaries(deps.machineDir, deps.replicaDeps);
  return all
    .filter((s) => s.pendingPublish)
    .map((s) => ({ lineageId: s.lineageId, sharedPath: s.sharedPath, fileName: s.sharedPath === null ? null : path.basename(s.sharedPath) }));
}

function freeExportPath(dir: string, stem: string): string {
  for (let n = 1; n <= EXPORT_NAME_ATTEMPTS; n++) {
    const candidate = path.join(dir, `${stem}${EXPORT_SUFFIX}${n === 1 ? '' : ` ${n}`}${VAULT_EXT}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${SYNC_LOG_PREFIX} no free export file name`);
}

/**
 * 5.11 [Export them] while sync is off: VACUUM INTO exports/<name> (unsynced changes).conduit
 * from a working copy that is not open. The caller reveals the file.
 */
export async function exportClosedLineage(lineageId: string, deps: LineageLookupDeps): Promise<string> {
  const summary = (await pendingVaults(deps)).find((p) => p.lineageId === lineageId);
  const lp = lineagePaths(deps.machineDir, lineageId);
  if (!fs.existsSync(lp.working)) throw new Error(NO_UNSYNCED_CHANGES_MESSAGE);
  fs.mkdirSync(lp.exports, { recursive: true });
  const target = freeExportPath(lp.exports, fileStem(summary?.fileName ?? 'Vault.conduit'));
  const db = new Database(lp.working, { fileMustExist: true });
  try {
    vacuumInto(db, target, deps.host.logger);
  } finally {
    db.close();
  }
  deps.host.logger.info(`${SYNC_LOG_PREFIX} exported a closed working copy`, { file: path.basename(target) });
  return target;
}
