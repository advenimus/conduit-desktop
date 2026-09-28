/**
 * The 5.10 pre-merge snapshot, shared by the shared-file merge (sync-cycle-merge.ts) and the
 * automatic merge of a provider conflict copy (copy-scanner.ts): before committing a merge that
 * deletes 10 or more live rows or changes 25 % of them, VACUUM INTO a copy of W with the diff.
 * The snapshot is taken before the 'mass-change' notice is persisted, so a notice (and its
 * [Undo]) never exists without the snapshot behind it; a retry after a failed take finds the
 * notice and takes the missing snapshot.
 */

import { makeImplicitProvider } from './hashing.js';
import type { NoticesPort } from './notices.js';
import type { ReplicaPort } from './replica.js';
import { diffMerge, isMassChange, type SnapshotStorePort } from './snapshots.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import type { EpochKeys, LocalNotice, SyncState } from './types.js';

export interface MassSnapshotDeps {
  readonly replica: Pick<ReplicaPort, 'implicit' | 'database' | 'ring'>;
  readonly snapshots: Pick<SnapshotStorePort, 'take' | 'list'>;
  readonly notices: Pick<NoticesPort, 'list' | 'addFromCapture'>;
  readonly host: Pick<SyncHost, 'clock' | 'random' | 'logger'>;
}

function storedNotice(deps: MassSnapshotDeps, sourceSha256: string): LocalNotice | undefined {
  return deps.notices.list().find((n) => n.kind === 'mass-change' && n.key === null && n.sourceSha256 === sourceSha256);
}

async function hasSnapshotFor(deps: MassSnapshotDeps, noticeId: string): Promise<boolean> {
  return (await deps.snapshots.list()).some((s) => s.meta.noticeId === noticeId);
}

/**
 * Takes the snapshot of W (its connection, outside any transaction) when merging `w` into `m`
 * is a mass change, then records the notice. Returns true for a mass change. A failed take
 * throws and records nothing, so the merge must not be committed. `under`: the epoch `w` and
 * `m` are both in when it is not W's current one (a password flow moves W before its merge).
 */
export async function takeMassSnapshot(
  deps: MassSnapshotDeps,
  w: SyncState,
  m: SyncState,
  sourceSha256: string,
  under?: EpochKeys,
): Promise<boolean> {
  const diff = diffMerge(w, m, under === undefined ? deps.replica.implicit() : makeImplicitProvider(under.kSync));
  if (!isMassChange(diff)) return false;
  const existing = storedNotice(deps, sourceSha256);
  const noticeId = existing?.id ?? deps.host.random.uuid();
  if (existing !== undefined && (await hasSnapshotFor(deps, noticeId))) return true;
  const epochId = under?.epochId ?? deps.replica.ring().current.epochId;
  await deps.snapshots.take({ db: deps.replica.database(), diff, sourceSha256, noticeId, epochId });
  if (existing !== undefined) {
    deps.host.logger.info(`${SYNC_LOG_PREFIX} took the pre-merge snapshot a failed attempt left missing`, { sha8: sourceSha256.slice(0, 8) });
    return true;
  }
  const count = diff.deleted.length > 0 ? diff.deleted.length : diff.changedRows;
  deps.notices.addFromCapture([{ id: noticeId, kind: 'mass-change', key: null, createdMs: deps.host.clock.now(), sourceSha256, count }]);
  return true;
}
