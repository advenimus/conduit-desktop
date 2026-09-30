/**
 * What a displaced device does (spec 6.6, 6.9, 12 rows 24/27/55/66): 1 block vault access
 * (overlay, locked error with reason open_elsewhere), 2 final sync cycle (merge + publish, at
 * most 15 s), 3 vault_session_release(lease_id, written_vv, pending = publish failed), 4 soft
 * lock (stop engine, heartbeat and backups; close W; clear the key and master-password buffer;
 * open terminals, RDP, VNC, web sessions and running commands keep running), 5 the
 * `vault:session-displaced` modal event (step 1 sends `vault:session-displacing` for the overlay). Idempotent; the whole sequence runs once. The
 * reconnect-conflict timer (6.8, 60 s without an answer) also ends here.
 */

import type { FinalOutcome } from '../sync/sync-engine.js';
import type { TimerHandle } from '../sync/host.js';
import type { BusyReport, DisplacementReason, LockedReason, SessionDisplacedEvent, SessionHost } from './host.js';

/** 6.2: final save when displaced, at most 15 s (the engine enforces the cap). */
export const DISPLACED_FINAL_SYNC_CAP_MS = 15_000;
/** 6.2: reconnect finds another holder; with no answer after 60 s this device soft-locks. */
export const RECONNECT_ANSWER_MS = 60_000;
/**
 * Backstop for a final cycle that never settles (a hung file operation): the engine's own cap
 * plus room for its last await, so the soft lock still happens "regardless" (6.2).
 */
export const FINAL_SYNC_BACKSTOP_MS = DISPLACED_FINAL_SYNC_CAP_MS + 2_000;
/** Backstop for the release and teardown steps (each is bounded by its own callee first). */
export const STEP_BACKSTOP_MS = 15_000;

const LOCK_REASON: LockedReason = 'open_elsewhere';
const NO_BUSY: BusyReport = Object.freeze({ sessions: 0, jobs: 0 });

export interface DisplacementDeps {
  readonly lineageId: string;
  readonly fileName: string | null;
  readonly host: Pick<SessionHost, 'access' | 'sessionEvents' | 'busy' | 'clock' | 'timers' | 'logger'>;
  /** engine.finalCycle('displaced'); null for private vaults (nothing to publish). */
  readonly finalSync: (() => Promise<FinalOutcome>) | null;
  /** vault_session_release with the unacknowledged marker and `pending`; no-op without a lease. */
  readonly release: (pending: boolean) => Promise<void>;
  /** Stops engine, heartbeat, realtime and stale wait; closes the replica (W). */
  readonly teardown: () => Promise<void>;
}

export interface DisplacementOutcome {
  readonly reason: DisplacementReason;
  readonly byDeviceName: string | null;
  readonly changesSaved: boolean;
}

type Bounded<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'failed' } | { readonly kind: 'timed-out' };

function errorMeta(err: unknown): { readonly error: string; readonly code: string | null } {
  const code = (err as { code?: unknown } | null)?.code;
  return { error: err instanceof Error ? err.name : typeof err, code: typeof code === 'string' ? code : null };
}

export class Displacement {
  private phase: 'idle' | 'in-progress' | 'soft-locked' = 'idle';
  private running: Promise<DisplacementOutcome> | null = null;
  private reconnect: { readonly handle: TimerHandle; readonly answerByMs: number } | null = null;

  constructor(private readonly deps: DisplacementDeps) {}

  /** Runs 6.6 once; later calls return the first call's promise. Never throws (logs and continues). */
  displace(reason: DisplacementReason, byDeviceName: string | null): Promise<DisplacementOutcome> {
    if (this.running !== null) return this.running;
    this.cancelReconnectTimer();
    this.phase = 'in-progress';
    this.running = this.run(reason, byDeviceName).catch((err: unknown) => this.recover(err, reason, byDeviceName));
    return this.running;
  }

  /** The running (or finished) displacement; null when none started. Never rejects. */
  settled(): Promise<DisplacementOutcome> | null {
    return this.running;
  }

  /** Between step 1 and the end of step 4. */
  inProgress(): boolean {
    return this.phase === 'in-progress';
  }

  /** Step 4 done. */
  softLocked(): boolean {
    return this.phase === 'soft-locked';
  }

  /**
   * 6.8: arm the 60 s answer timer; on expiry displace('reconnect_unanswered'). Returns the
   * answer-by time; a timer already armed keeps its original deadline (repeated conflicts from
   * the acquire retry must not postpone the soft lock).
   */
  armReconnectTimer(byDeviceName: string | null = null): number {
    const { clock, timers, logger } = this.deps.host;
    if (this.phase !== 'idle') return clock.now();
    if (this.reconnect !== null) return this.reconnect.answerByMs;
    const answerByMs = clock.now() + RECONNECT_ANSWER_MS;
    const handle = timers.setTimeout(() => {
      this.reconnect = null;
      logger.warn('[vault-session] reconnect conflict unanswered');
      void this.displace('reconnect_unanswered', byDeviceName);
    }, RECONNECT_ANSWER_MS);
    this.reconnect = { handle, answerByMs };
    return answerByMs;
  }

  cancelReconnectTimer(): void {
    this.reconnect?.handle.cancel();
    this.reconnect = null;
  }

  private async run(reason: DisplacementReason, byDeviceName: string | null): Promise<DisplacementOutcome> {
    const { access, logger } = this.deps.host;
    logger.info('[vault-session] displacement started', { reason });
    this.syncStep('block access', () => access.blockAccess(LOCK_REASON));
    this.syncStep('displacing event', () =>
      this.deps.host.sessionEvents.emit('vault:session-displacing', { lineageId: this.deps.lineageId, reason, byDeviceName }),
    );
    const changesSaved = await this.finalSave();
    await this.bounded('release', () => this.deps.release(!changesSaved), STEP_BACKSTOP_MS);
    await this.bounded('teardown', () => this.deps.teardown(), STEP_BACKSTOP_MS);
    this.syncStep('soft lock', () => access.softLock(LOCK_REASON));
    this.phase = 'soft-locked';
    this.emitDisplaced(reason, byDeviceName, changesSaved);
    logger.info('[vault-session] displacement finished', { reason, changesSaved });
    return { reason, byDeviceName, changesSaved };
  }

  private async finalSave(): Promise<boolean> {
    const finalSync = this.deps.finalSync;
    if (finalSync === null) return true;
    const res = await this.bounded('final sync', finalSync, FINAL_SYNC_BACKSTOP_MS);
    if (res.kind !== 'done') return false;
    if (res.value.timedOut) this.deps.host.logger.warn('[vault-session] final sync hit its cap', { published: res.value.published });
    return res.value.published || !res.value.pendingPublish;
  }

  private emitDisplaced(reason: DisplacementReason, byDeviceName: string | null, changesSaved: boolean): void {
    const busy = this.readBusy();
    const event: SessionDisplacedEvent = {
      lineageId: this.deps.lineageId,
      reason,
      byDeviceName,
      openConnections: busy.sessions,
      runningJobs: busy.jobs,
      changesSaved,
      fileName: this.deps.fileName,
    };
    this.syncStep('displaced event', () => this.deps.host.sessionEvents.emit('vault:session-displaced', event));
  }

  private readBusy(): BusyReport {
    try {
      return this.deps.host.busy.busy();
    } catch (err) {
      this.deps.host.logger.error('[vault-session] busy report failed', errorMeta(err));
      return NO_BUSY;
    }
  }

  private syncStep(step: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.host.logger.error(`[vault-session] displacement step failed: ${step}`, errorMeta(err));
    }
  }

  private async bounded<T>(step: string, fn: () => Promise<T>, capMs: number): Promise<Bounded<T>> {
    const { timers, logger } = this.deps.host;
    let handle: TimerHandle | null = null;
    const timeout = new Promise<Bounded<T>>((resolve) => {
      handle = timers.setTimeout(() => resolve({ kind: 'timed-out' }), capMs);
    });
    const work = (async (): Promise<Bounded<T>> => {
      try {
        return { kind: 'done', value: await fn() };
      } catch (err) {
        logger.error(`[vault-session] displacement step failed: ${step}`, errorMeta(err));
        return { kind: 'failed' };
      }
    })();
    const res = await Promise.race([work, timeout]);
    (handle as TimerHandle | null)?.cancel();
    if (res.kind === 'timed-out') logger.warn(`[vault-session] displacement step timed out: ${step}`, { capMs });
    return res;
  }

  private recover(err: unknown, reason: DisplacementReason, byDeviceName: string | null): DisplacementOutcome {
    this.deps.host.logger.error('[vault-session] displacement failed', errorMeta(err));
    if (this.phase !== 'soft-locked') {
      this.syncStep('soft lock', () => this.deps.host.access.softLock(LOCK_REASON));
      this.phase = 'soft-locked';
    }
    return { reason, byDeviceName, changesSaved: false };
  }
}
