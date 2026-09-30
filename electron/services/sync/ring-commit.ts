import type { CommitOutcome, ReplicaPort } from './replica.js';
import type { KeyRing, SyncState } from './types.js';

type RingCommitPort = Pick<ReplicaPort, 'ring' | 'setRing' | 'commit'>;

/** A failed commit puts the previous ring and key back, as Replica.changePassword does. */
export function commitUnderRing(replica: RingCommitPort, ring: KeyRing, key: Buffer, next: SyncState): CommitOutcome {
  const previous = replica.ring();
  replica.setRing(ring, key);
  try {
    return replica.commit(next);
  } catch (err) {
    replica.setRing(previous, previous.current.kEpoch);
    throw err;
  }
}
