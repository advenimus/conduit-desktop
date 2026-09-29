/**
 * Owner claims and the owner tag while a vault runs (spec 6.5, 6.7, 12 rows 28/29/62;
 * docs/PLAN_ENFORCEMENT.md 3.2): after
 * every merge the claims check is scheduled on a zero timer and then queued in the engine's
 * lane (never inside the engine's call, coalesced), and it displaces this device when another
 * device holds the provisional claim of W as it is at check time; a take-over writes this
 * device's claim when claims apply. The watch is armed only when the runtime starts: the unlock
 * cycle's merge comes before this device wrote its own claim (6.7 "claim silently").
 * Part of session-runtime.ts.
 */

import { accountHint } from '../sync/hashing.js';
import type { ReplicaPort } from '../sync/replica.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import type { TimerHandle } from '../sync/host.js';
import type { SyncState } from '../sync/types.js';
import { claimWrites, evaluateClaims, shouldDisplace } from './claims.js';
import { claimsApply } from './effective-limit.js';
import type { LeaseTracker } from './lease.js';
import type { SessionHost } from './host.js';
import { ownerHint, ownerTagWritesFor, readOwnerTag, releasedTagWrites } from './owner-tag.js';
import type { Ownership } from './session-client.js';
import { P, errorMeta, guarded } from './session-runtime-parts.js';

export interface ClaimsWatchDeps {
  readonly host: Pick<SessionHost, 'clock' | 'timers' | 'logger'>;
  readonly shared: boolean;
  readonly ownDeviceUuid: string;
  readonly lease: LeaseTracker;
  readonly effectiveLimit: () => number;
  /** Closing, displacing or soft-locked: no claims check runs. */
  readonly inactive: () => boolean;
  readonly displace: (byDeviceName: string | null) => void;
  /** W's state when the check runs (a claim written after the merge counts), null without W. */
  readonly current: () => SyncState | null;
  /** Queues the check behind the work already in the engine's lane (the open's claim write). */
  readonly inLane: (fn: () => void) => Promise<void>;
}

export class ClaimsWatch {
  private timer: TimerHandle | null = null;
  private armed = false;

  constructor(private readonly deps: ClaimsWatchDeps) {}

  /** runtime.start(): this device's own claim is written (or queued in the lane before any check). */
  arm(): void {
    this.armed = true;
  }

  /** SessionSignals.afterMerge and limit changes: one check soon, against W as it is then. */
  schedule(): void {
    if (!this.armed || !this.deps.shared || this.deps.inactive() || this.timer !== null) return;
    const { host } = this.deps;
    this.timer = host.timers.setTimeout(() => {
      this.timer = null;
      this.deps.inLane(() => guarded(host.logger, 'claims check', () => this.check())).catch((err: unknown) => {
        host.logger.debug(`${P} claims check not run`, errorMeta(err));
      });
    }, 0);
  }

  cancel(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private check(): void {
    if (this.deps.inactive()) return;
    const state = this.deps.current();
    if (state === null) return;
    const { lease, host } = this.deps;
    const nowMs = host.clock.now();
    const verdict = evaluateClaims({
      state,
      ownDeviceUuid: this.deps.ownDeviceUuid,
      effectiveLimit: this.deps.effectiveLimit(),
      shared: this.deps.shared,
      leaseConfirmed: lease.isConfirmed(nowMs),
      sessions: lease.sessions(),
      nowMs,
    });
    if (!shouldDisplace(verdict) || verdict.kind !== 'other') return;
    host.logger.info(`${P} another device holds the owner claim; displacing`);
    this.deps.displace(verdict.presence?.name ?? null);
  }
}

/** 6.5 / 6.8: the device that takes over writes its owner claim when claims apply (limit 1). */
export async function writeOwnerClaim(
  host: Pick<SessionHost, 'account' | 'logger'>,
  replica: ReplicaPort | null,
  engine: SyncEngine | null,
  limit: number,
): Promise<void> {
  if (replica === null || engine === null || !claimsApply(limit)) return;
  const userId = host.account.userId();
  const hint = userId === null ? null : accountHint(replica.lineageId, userId);
  try {
    await engine.exclusive(() => replica.applyWrites(claimWrites(hint, replica.context()), { interactive: true, ruleR: false }));
  } catch (err) {
    host.logger.error(`${P} owner claim was not written`, errorMeta(err));
  }
}

/** 3.2: a confirmed owner writes its hint into the owner tag when the tag says something else. */
export async function writeOwnerTag(
  host: Pick<SessionHost, 'account' | 'logger'>,
  replica: ReplicaPort | null,
  engine: SyncEngine | null,
  ownership: Ownership | null,
): Promise<void> {
  const userId = host.account.userId();
  if (replica === null || engine === null || ownership?.kind !== 'owner' || userId === null) return;
  const hint = ownerHint(replica.lineageId, userId);
  if (readOwnerTag(replica.state())?.a === hint) return;
  try {
    await engine.exclusive(() => {
      const writes = ownerTagWritesFor(ownership, hint, replica.state(), replica.context());
      if (writes.length > 0) replica.applyWrites(writes, { interactive: true, ruleR: false });
    });
  } catch (err) {
    host.logger.error(`${P} owner tag was not written`, errorMeta(err));
  }
}

/** 3.2: {"a": null} right after a confirmed release. */
export async function writeReleasedTag(host: Pick<SessionHost, 'logger'>, replica: ReplicaPort | null, engine: SyncEngine | null): Promise<void> {
  if (replica === null || engine === null) return;
  try {
    await engine.exclusive(() => {
      const writes = releasedTagWrites(replica.state(), replica.context());
      if (writes.length > 0) replica.applyWrites(writes, { interactive: true, ruleR: false });
    });
    engine.trigger('local-edit');
  } catch (err) {
    host.logger.error(`${P} released owner tag was not written`, errorMeta(err));
  }
}
