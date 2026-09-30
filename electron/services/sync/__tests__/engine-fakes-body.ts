// Scripted cycle bodies and tracker doubles for sync-engine tests: the steps a fake cycle takes
// (outcomes, blocking on a gate, recording a publish like the real cycle, reading S) and
// subclasses of the sync-verify trackers with the 5.6 / 5.7 semantics.
import { Backoff, PublishVerifier, RegressionTracker, type PublishedRecord, type VerifyVerdict } from '../sync-verify.js';
import { TornTracker } from '../shared-file.js';
import type { CycleOutcome, SyncTrigger } from '../sync-engine.js';
import type { CycleEnv } from '../sync-cycle.js';
import type { AppDot, SyncState } from '../types.js';

export const LINEAGE = '11111111-2222-4333-8444-555555555555';
export const DEVICE = '22222222-3333-4444-8555-666666666666';
export const DEV = 7;
export const SHA_S = 'a'.repeat(64);
export const SHA_P = 'b'.repeat(64);
export const MARKER: AppDot = { dev: DEV, ms: 1_000, c: 0 };

// ---------- trackers (sync-verify semantics, independent of its implementation) ----------

export class TestBackoff extends Backoff {
  private step = 0;
  constructor() {
    super(5_000, 600_000);
  }
  override next(): number {
    const d = Math.min(5_000 * 2 ** this.step, 600_000);
    this.step += 1;
    return d;
  }
  override reset(): void {
    this.step = 0;
  }
  override active(): boolean {
    return this.step > 0;
  }
}

export class TestVerifier extends PublishVerifier {
  record: PublishedRecord | null = null;
  verdict: VerifyVerdict = 'covered';
  override recordPublish(p: PublishedRecord): readonly number[] {
    this.record = p;
    return [p.atMs + 15_000, p.atMs + 60_000];
  }
  override check(): VerifyVerdict {
    return this.record === null ? 'no-publish' : this.verdict;
  }
  override last(): PublishedRecord | null {
    return this.record;
  }
}

export class TestRegressions extends RegressionTracker {
  blocked: number | null = null;
  settled = 0;
  override record(): number | null {
    return this.blocked;
  }
  override blockedUntil(nowMs: number): number | null {
    return this.blocked !== null && this.blocked > nowMs ? this.blocked : null;
  }
  override settle(): void {
    this.settled += 1;
  }
}

export class TestTorn extends TornTracker {
  override observe(): never {
    throw new Error('TestTorn.observe unused');
  }
  override reset(): void {}
}

// ---------- scripted cycle body ----------

export type Step = (env: CycleEnv, reason: SyncTrigger) => Promise<CycleOutcome>;

export interface BodyCall {
  readonly reason: SyncTrigger;
  readonly atMs: number;
  readonly closing: boolean;
}

export const UP_TO_DATE: CycleOutcome = { kind: 'up-to-date', merged: false };

export class ScriptedBody {
  readonly calls: BodyCall[] = [];
  private readonly steps: Step[] = [];
  fallback: Step = async () => UP_TO_DATE;

  constructor(private readonly now: () => number) {}

  /** Queues the behavior of the next cycles, in order. */
  then(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  readonly run = (env: CycleEnv, reason: SyncTrigger): Promise<CycleOutcome> => {
    this.calls.push({ reason, atMs: this.now(), closing: env.closing });
    const step = this.steps.shift() ?? this.fallback;
    return step(env, reason);
  };

  reasons(): SyncTrigger[] {
    return this.calls.map((c) => c.reason);
  }
}

export function outcome(o: CycleOutcome): Step {
  return async () => o;
}

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Blocks the cycle until `gate` opens, then checks alive (like the real cycle after an await). */
export function blocked(gate: Deferred, o: CycleOutcome = UP_TO_DATE): Step {
  return async (env) => {
    await gate.promise;
    env.checkAlive();
    return o;
  };
}

/** What the real cycle does on a verified publish: record P, report the marker, clear pending. */
export function publishes(sha256: string = SHA_P, marker: AppDot = MARKER): Step {
  return async (env) => {
    env.verifier.recordPublish({ sha256, marker, state: env.deps.replica.state(), atMs: env.deps.host.clock.now() });
    env.memory.unsyncedOps = 0;
    env.deps.replica.updateLocal((l) => ({ ...l, pendingPublish: false, lastPublished: { sha256, markerDot: marker } }));
    env.deps.session.published(marker);
    return { kind: 'published', sha256, marker };
  };
}

/** A cycle that reads S (the session tap sees its state) and then reports `o`. */
export function reads(state: SyncState, o: CycleOutcome = UP_TO_DATE): Step {
  return async (env) => {
    env.deps.session.sharedRead(state);
    return o;
  };
}
