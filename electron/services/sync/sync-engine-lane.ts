/**
 * The engine's lane (one promise chain: cycles and user actions never interleave) and the
 * single-flight gate of spec 5.6: while a cycle runs, every caller shares ONE queued follow-up
 * cycle, so a change seen mid-cycle is never lost and N triggers cost one extra cycle.
 */

import type { CycleOutcome, SyncTrigger } from './sync-engine-types.js';

export class Lane {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  /** Queues `fn` after everything already queued; its result or error reaches the caller only. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => this.leave(),
      () => this.leave(),
    );
    return result;
  }

  busy(): boolean {
    return this.depth > 0;
  }

  /** Resolves once nothing is queued or running (work queued meanwhile is waited for too). */
  async whenIdle(): Promise<void> {
    while (this.depth > 0) await this.tail;
  }

  private leave(): void {
    this.depth -= 1;
  }
}

export type CycleExecutor = (reason: SyncTrigger, deadlineMs: number | undefined) => Promise<CycleOutcome>;

interface PendingCycle {
  reason: SyncTrigger;
  deadlineMs: number | undefined;
  promise: Promise<CycleOutcome> | null;
}

function earlierDeadline(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** A final cycle that joins a queued follow-up keeps its purpose (closing presence, caps). */
function joinedReason(current: SyncTrigger, incoming: SyncTrigger): SyncTrigger {
  return incoming === 'final' ? 'final' : current;
}

export class CycleGate {
  private pending: PendingCycle | null = null;

  constructor(
    private readonly lane: Lane,
    private readonly execute: CycleExecutor,
  ) {}

  /** The queued (not yet started) cycle, shared by every caller until it starts. */
  request(reason: SyncTrigger, deadlineMs: number | undefined): Promise<CycleOutcome> {
    const queued = this.pending;
    if (queued !== null && queued.promise !== null) {
      queued.reason = joinedReason(queued.reason, reason);
      queued.deadlineMs = earlierDeadline(queued.deadlineMs, deadlineMs);
      return queued.promise;
    }
    const next: PendingCycle = { reason, deadlineMs, promise: null };
    this.pending = next;
    next.promise = this.lane.run(() => {
      if (this.pending === next) this.pending = null;
      return this.execute(next.reason, next.deadlineMs);
    });
    return next.promise;
  }
}

/** Same single-flight rule for copy scans (directory events come in bursts). */
export class SingleFlight<T> {
  private pending: Promise<T> | null = null;

  constructor(private readonly lane: Lane) {}

  request(fn: () => Promise<T>): Promise<T> {
    if (this.pending !== null) return this.pending;
    const promise: Promise<T> = this.lane.run(() => {
      if (this.pending === promise) this.pending = null;
      return fn();
    });
    this.pending = promise;
    return promise;
  }
}
