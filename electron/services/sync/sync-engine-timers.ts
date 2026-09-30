/**
 * Every schedule the engine owns (spec 5.6 triggers, 5.7 verification, 5.8 scans), on the
 * host's timers so FakeClock drives them in tests: the local-edit burst (2 s after the last
 * edit, at most 10 s after the first), one retry slot (torn retries, error and regression
 * back-off, missing-file re-checks), the covers checks after a publish, and the safety poll and
 * copy-scan intervals. cancelAll() leaves nothing scheduled.
 */

import type { Clock, TimerHandle, Timers } from './host.js';

export interface BurstRule {
  readonly idleMs: number;
  readonly maxMs: number;
}

export class EngineTimers {
  private burstStartMs: number | null = null;
  private editTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private retryAtMs: number | null = null;
  private verifyTimers: TimerHandle[] = [];
  private intervals: TimerHandle[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly timers: Timers,
    private readonly burst: BurstRule,
  ) {}

  /** Local edit: fire `idleMs` after the latest edit, but no later than `maxMs` after the burst's first. */
  armLocalEdit(fire: () => void): void {
    const now = this.clock.now();
    if (this.burstStartMs === null) this.burstStartMs = now;
    const due = Math.min(now + this.burst.idleMs, this.burstStartMs + this.burst.maxMs);
    this.editTimer?.cancel();
    this.editTimer = this.timers.setTimeout(() => {
      this.editTimer = null;
      this.burstStartMs = null;
      fire();
    }, Math.max(0, due - now));
  }

  clearLocalEdit(): void {
    this.editTimer?.cancel();
    this.editTimer = null;
    this.burstStartMs = null;
  }

  /** One retry slot: the latest cycle outcome decides the next attempt. */
  scheduleRetry(atMs: number, fire: () => void): void {
    this.clearRetry();
    this.retryAtMs = atMs;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.retryAtMs = null;
      fire();
    }, Math.max(0, atMs - this.clock.now()));
  }

  retryAt(): number | null {
    return this.retryAtMs;
  }

  clearRetry(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
    this.retryAtMs = null;
  }

  /** Replaces the checks of the previous publish; `fire(isLast)` runs at each absolute time. */
  scheduleVerify(atMs: readonly number[], fire: (isLast: boolean) => void): void {
    this.clearVerify();
    const sorted = [...atMs].sort((a, b) => a - b);
    this.verifyTimers = sorted.map((at, i) =>
      this.timers.setTimeout(() => fire(i === sorted.length - 1), Math.max(0, at - this.clock.now())),
    );
  }

  clearVerify(): void {
    for (const t of this.verifyTimers) t.cancel();
    this.verifyTimers = [];
  }

  startInterval(ms: number, fire: () => void): void {
    this.intervals.push(this.timers.setInterval(fire, ms));
  }

  /** Everything but the intervals (the final cycle stops new cycles, stop() ends the rest). */
  clearCycleTimers(): void {
    this.clearLocalEdit();
    this.clearRetry();
    this.clearVerify();
  }

  cancelAll(): void {
    this.clearCycleTimers();
    for (const t of this.intervals) t.cancel();
    this.intervals = [];
  }
}

export type RaceResult<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'timeout' };

/** Resolves with the promise's value, or 'timeout' after `ms` (the timer is cancelled when the promise wins). */
export function raceTimeout<T>(p: Promise<T>, ms: number, timers: Timers): Promise<RaceResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => resolve({ kind: 'timeout' }), ms);
    p.then(
      (value) => {
        timer.cancel();
        resolve({ kind: 'done', value });
      },
      (err: unknown) => {
        timer.cancel();
        reject(err);
      },
    );
  });
}
