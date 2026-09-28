/**
 * Publish verification schedule (spec 5.7): after every publish, check cycles at +15 s and
 * +60 s (the cycle tests covers(S, P) on every read and republishes on a regression); when the
 * last check read S and P is still covered, the regression back-off step resets.
 */

import { COVERS_CHECK_DELAYS_MS, type PublishedRecord, type PublishVerifier, type RegressionTracker } from './sync-verify.js';
import type { EngineTimers } from './sync-engine-timers.js';
import type { CycleOutcome } from './sync-engine-types.js';
import type { SyncLogger } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { SyncState } from './types.js';

export interface VerifyHooks {
  readonly verifier: PublishVerifier;
  readonly regressions: RegressionTracker;
  readonly timers: EngineTimers;
  readonly logger: SyncLogger;
  runVerifyCycle(): Promise<CycleOutcome>;
  /** Not stopped and not closing. */
  active(): boolean;
  /** Count of S reads that produced a state, and the latest such state. */
  sharedReads(): number;
  sharedState(): SyncState | null;
}

export class VerifySchedule {
  constructor(private readonly h: VerifyHooks) {}

  /** The cycle published and recorded P: schedule its checks from the recorded time. */
  afterCyclePublish(sha256: string): void {
    const rec = this.h.verifier.last();
    if (rec === null || rec.sha256 !== sha256) {
      this.h.logger.warn(`${SYNC_LOG_PREFIX} publish was not recorded for verification`, { sha8: sha256.slice(0, 8) });
      return;
    }
    this.schedule(sha256, COVERS_CHECK_DELAYS_MS.map((d) => rec.atMs + d));
  }

  /** A publish made outside the cycle: record P here, then schedule. */
  afterDirectPublish(rec: PublishedRecord): void {
    this.schedule(rec.sha256, this.h.verifier.recordPublish(rec));
  }

  private schedule(sha256: string, atMs: readonly number[]): void {
    if (!this.h.active()) return;
    this.h.timers.scheduleVerify(atMs, (isLast) => {
      this.run(sha256, isLast).catch((err: unknown) =>
        this.h.logger.warn(`${SYNC_LOG_PREFIX} publish verification failed`, { name: (err as Error)?.name ?? 'Error' }),
      );
    });
  }

  private async run(sha256: string, isLast: boolean): Promise<void> {
    if (!this.h.active()) return;
    const readsBefore = this.h.sharedReads();
    await this.h.runVerifyCycle();
    if (!isLast || !this.h.active()) return;
    const rec = this.h.verifier.last();
    const s = this.h.sharedState();
    if (rec === null || rec.sha256 !== sha256 || this.h.sharedReads() === readsBefore || s === null) return;
    if (this.h.verifier.check(s) === 'covered') this.h.regressions.settle();
  }
}
