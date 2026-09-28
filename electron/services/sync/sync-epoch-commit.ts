/**
 * Commit of a password flow's merge (spec 4.8) with the same 5.10 pre-merge snapshot a cycle
 * takes: each flow builds a plan synchronously (W moved into the new epoch, the merged state,
 * the ring), the snapshot of W and its 'mass-change' notice are written, then the plan commits
 * under the new ring. A write that lands on W while the snapshot is written moves W's
 * generation and the plan is rebuilt from W as it is then, as 5.6 commitMerge does.
 */

import type { NoticesPort } from './notices.js';
import { captureSkippedWrites, type CommitOutcome, type ReplicaPort } from './replica.js';
import { commitUnderRing } from './ring-commit.js';
import type { SnapshotStorePort } from './snapshots.js';
import { COMMIT_ATTEMPTS } from './sync-engine-constants.js';
import { takeMassSnapshot } from './sync-mass-snapshot.js';
import type { SyncHost } from './host.js';
import type { KeyRing, SyncState } from './types.js';

export interface EpochPlan {
  /** W moved into the new epoch before the merge: the snapshot diff's "before". */
  readonly before: SyncState;
  /** The state the commit writes. */
  readonly next: SyncState;
  readonly ring: KeyRing;
  /** The key ConduitVault switches to. */
  readonly key: Buffer;
  /** Runs after the commit (held changes, notices, logs). */
  readonly after: () => void;
}

/** Where a password flow keeps its pre-merge snapshot and the 'mass-change' notice. */
export interface EpochSnapshotPorts {
  readonly snapshots: Pick<SnapshotStorePort, 'take' | 'list'>;
  readonly notices: Pick<NoticesPort, 'list' | 'addFromCapture'>;
}

type CommitHost = Pick<SyncHost, 'clock' | 'random' | 'logger'>;

function commitPlan(replica: ReplicaPort, p: EpochPlan): CommitOutcome {
  const out = commitUnderRing(replica, p.ring, p.key, p.next);
  p.after();
  return out;
}

/**
 * Snapshot (when the plan is a mass change for `sourceSha256`), then commit. A failed
 * snapshot throws before anything is committed. After COMMIT_ATTEMPTS generation changes the
 * last plan commits with the snapshot already taken for this S.
 */
export async function commitEpochPlan(
  replica: ReplicaPort,
  ports: EpochSnapshotPorts,
  host: CommitHost,
  sourceSha256: string,
  plan: () => EpochPlan,
): Promise<CommitOutcome> {
  const deps = { replica, snapshots: ports.snapshots, notices: ports.notices, host };
  for (let i = 0; i < COMMIT_ATTEMPTS; i++) {
    const p = plan();
    const gen = replica.generation();
    await takeMassSnapshot(deps, p.before, p.next, sourceSha256, p.ring.current);
    captureSkippedWrites(replica);
    if (replica.generation() === gen) return commitPlan(replica, p);
  }
  return commitPlan(replica, plan());
}
