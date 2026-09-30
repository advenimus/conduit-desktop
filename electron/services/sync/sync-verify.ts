/**
 * Lost updates and back-off (spec 5.6 back-off, 5.7, 12 rows 7/8): after a publish, test
 * covers(S, P) at +15 s and +60 s and on every later read; a failed test is a regression (the
 * cloud kept another version): the cycle merges again and republishes. More than 3 regressions
 * in 10 minutes back off publishing from 5 s doubling up to 5 min ("OneDrive keeps restoring an
 * older copy of this vault"). Also the generic error back-off (5 s doubling to 10 min).
 * Pure bookkeeping over injected times.
 */

import { covers } from './digest.js';
import type { AppDot, SyncState } from './types.js';

/** 5.7: covers(S, P) checks after a publish. */
export const COVERS_CHECK_DELAYS_MS = [15_000, 60_000] as const;
/** 5.7: more than 3 regressions in 10 minutes back off writes, 5 s up to 5 min. */
export const REGRESSION_WINDOW_MS = 10 * 60 * 1000;
export const REGRESSION_LIMIT = 3;
export const REGRESSION_BACKOFF_START_MS = 5_000;
export const REGRESSION_BACKOFF_MAX_MS = 5 * 60 * 1000;

export interface PublishedRecord {
  readonly sha256: string;
  readonly marker: AppDot;
  /** W's state exactly as vacuumed into the publish (P). */
  readonly state: SyncState;
  readonly atMs: number;
}

export type VerifyVerdict = 'no-publish' | 'covered' | 'regressed';

export class PublishVerifier {
  private published: PublishedRecord | null = null;
  private lossCounted: PublishedRecord | null = null;

  /** Records P; returns the absolute times of the covers checks to schedule. */
  recordPublish(p: PublishedRecord): readonly number[] {
    this.published = p;
    return COVERS_CHECK_DELAYS_MS.map((d) => p.atMs + d);
  }

  /**
   * digest.covers(S, P) against the last publish. 'regressed' keeps the record (the next
   * publish replaces it); 'covered' keeps it too, since every later read re-checks (5.7).
   */
  check(sState: SyncState): VerifyVerdict {
    if (this.published === null) return 'no-publish';
    return covers(sState, this.published.state) ? 'covered' : 'regressed';
  }

  last(): PublishedRecord | null {
    return this.published;
  }

  /**
   * 5.7 counts lost publishes, not reads: true only the first time the current publish is found
   * lost. Re-reading the same old copy while publishing is backed off must not renew the back-off
   * forever, or this device would never republish.
   */
  claimLoss(): boolean {
    const current = this.last();
    if (current === null || this.lossCounted === current) return false;
    this.lossCounted = current;
    return true;
  }
}

export class RegressionTracker {
  private times: readonly number[] = [];
  private nextDelayMs = REGRESSION_BACKOFF_START_MS;
  private untilMs: number | null = null;

  /** Records a regression at nowMs; returns the publish block end when back-off starts or grows. */
  record(nowMs: number): number | null {
    this.times = [...this.times.filter((t) => nowMs - t < REGRESSION_WINDOW_MS), nowMs];
    if (this.times.length <= REGRESSION_LIMIT) return null;
    this.untilMs = nowMs + this.nextDelayMs;
    this.nextDelayMs = Math.min(this.nextDelayMs * 2, REGRESSION_BACKOFF_MAX_MS);
    return this.untilMs;
  }

  /** End of the current publish back-off, or null. */
  blockedUntil(nowMs: number): number | null {
    return this.untilMs !== null && this.untilMs > nowMs ? this.untilMs : null;
  }

  /** A publish stayed covered through its last check: the back-off step resets. */
  settle(): void {
    this.nextDelayMs = REGRESSION_BACKOFF_START_MS;
    this.times = [];
  }
}

/** Error back-off: 5 s doubling to 10 min (5.6). */
export class Backoff {
  private currentMs: number;
  private pending = false;

  constructor(
    private readonly startMs: number,
    private readonly maxMs: number,
  ) {
    this.currentMs = startMs;
  }

  /** Next delay (doubling), capped. */
  next(): number {
    const delay = this.currentMs;
    this.currentMs = Math.min(this.currentMs * 2, this.maxMs);
    this.pending = true;
    return delay;
  }

  reset(): void {
    this.currentMs = this.startMs;
    this.pending = false;
  }

  /** true when a delay is pending (next() was called since the last reset()). */
  active(): boolean {
    return this.pending;
  }
}
