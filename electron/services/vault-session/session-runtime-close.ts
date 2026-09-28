/**
 * The release points of one open vault (spec 6.4, 6.6 steps 3-4, 6.11 markers):
 * the bounded vault_session_release with the unacknowledged publish marker and the pending
 * flag, the final cycle of lock and quit, and the teardown every exit runs (stale wait, engine,
 * heartbeat, Realtime, W). Each step's error is logged and the next step still runs.
 * Part of session-runtime.ts.
 */

import type { ReplicaPort } from '../sync/replica.js';
import type { FinalKind, FinalOutcome, SyncEngine } from '../sync/sync-engine.js';
import type { HeartbeatLoop } from './heartbeat.js';
import type { LeaseTracker } from './lease.js';
import type { SessionRealtime } from './realtime.js';
import type { SessionClientPort, SessionIds } from './session-client.js';
import type { StaleWait } from './stale-wait.js';
import type { SessionHost } from './host.js';
import { FINAL_SYNC_BACKSTOP_MS, STEP_BACKSTOP_MS } from './displacement.js';
import { P, guarded, settleWithin } from './session-runtime-parts.js';

export interface CloseParts {
  readonly host: SessionHost;
  readonly ids: SessionIds;
  readonly client: SessionClientPort;
  readonly lease: LeaseTracker;
  readonly replica: ReplicaPort | null;
  readonly engine: SyncEngine | null;
  readonly heartbeat: HeartbeatLoop | null;
  readonly realtime: SessionRealtime | null;
  readonly staleWait: StaleWait | null;
}

/** No engine (private vault) or a final cycle that failed: W's pending flag decides. */
function noCycle(replica: ReplicaPort | null, marker: FinalOutcome['marker']): FinalOutcome {
  let pending = false;
  try {
    pending = replica?.local().pendingPublish ?? false;
  } catch {
    pending = true;
  }
  return { published: false, timedOut: false, pendingPublish: pending, marker };
}

/** engine.finalCycle(kind) with a backstop: a hung cycle still lets the release and close happen. */
export async function runFinalCycle(parts: CloseParts, kind: FinalKind): Promise<FinalOutcome> {
  const { engine, host, replica } = parts;
  if (engine === null) return noCycle(replica, null);
  const res = await settleWithin(engine.finalCycle(kind), FINAL_SYNC_BACKSTOP_MS, host.timers, host.logger, `final cycle (${kind})`);
  if (res.kind === 'done') return res.value;
  return { ...noCycle(replica, null), pendingPublish: true, timedOut: res.kind === 'timed-out' };
}

/**
 * vault_session_release with the marker not yet acknowledged and `pending`; true when the
 * server answered. No lease or signed out: nothing to release (false).
 */
export async function releaseLease(parts: CloseParts, pending: boolean, timeoutMs: number): Promise<boolean> {
  const { lease, client, host, ids } = parts;
  const leaseId = lease.releaseLeaseId();
  if (leaseId === null || host.account.userId() === null) return false;
  const marker = lease.markerToSend();
  const res = await settleWithin(client.release({ ...ids, leaseId, marker, pending }, timeoutMs), timeoutMs, host.timers, host.logger, 'release');
  if (res.kind !== 'done') return false;
  if (res.value.kind !== 'ok') {
    host.logger.warn(`${P} release not confirmed`, { reason: res.value.reason, detail: res.value.detail });
    return false;
  }
  if (marker !== null) lease.markerAcknowledged(marker);
  return true;
}

/** Stops everything that runs for this vault (stale wait, engine, heartbeat, Realtime). Idempotent. */
export async function stopRunning(parts: CloseParts): Promise<void> {
  const { host, engine, heartbeat, realtime, staleWait } = parts;
  guarded(host.logger, 'stale wait', () => staleWait?.dispose());
  if (engine !== null) await settleWithin(engine.stop(), STEP_BACKSTOP_MS, host.timers, host.logger, 'engine stop');
  guarded(host.logger, 'heartbeat stop', () => heartbeat?.stop());
  guarded(host.logger, 'realtime stop', () => realtime?.stop());
}

/** Closes W (ConduitVault.lock through the handle); replica.close is idempotent. */
export function closeWorkingCopy(parts: CloseParts): void {
  guarded(parts.host.logger, 'close working copy', () => parts.replica?.close());
}

/** 6.6 step 4 teardown: stop everything, then close W. */
export async function teardown(parts: CloseParts): Promise<void> {
  await stopRunning(parts);
  closeWorkingCopy(parts);
}
