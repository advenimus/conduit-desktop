/**
 * The lease loop of one open vault (spec 6.2, 6.8, 6.9, 12 rows 24/27/35/68): heartbeat every
 * 30 s while unlocked with p_active (idle < 60 s or window focused in the last 60 s), busy
 * counts, side-file flag, file hint and the unacknowledged publish marker; re-acquire every
 * 60 s while unconfirmed; on 'lost' (released/expired/unknown) a normal acquire; 'superseded'
 * and 'displaced' go to the displacement handler; powerMonitor suspend stops the loop, resume
 * beats at once. A heartbeat never revives a lease (the server refuses); only acquire does.
 */

import { SESSION_LOG_PREFIX, type TimerHandle } from '../sync/host.js';
import type { LeaseTracker } from './lease.js';
import type { AcquireArgs, AcquireResult, DenialCause, HeartbeatArgs, HeartbeatResult, Ownership, SessionClientPort, SessionIds } from './session-client.js';
import type { DisplacedDetail, DisplacementReason, Holder, SessionHost } from './host.js';
import { acknowledgesMarker, actionFor, errorName, heartbeatArgs, readContext } from './heartbeat-inputs.js';

export { ACTIVE_WINDOW_MS, isActive } from './heartbeat-inputs.js';

export const HEARTBEAT_MS = 30_000;
/** 6.2 offline retry of acquire. */
export const OFFLINE_RETRY_MS = 60_000;

const P = SESSION_LOG_PREFIX;

/** Per-beat facts supplied by the runtime (sync layer state). */
export interface HeartbeatContext {
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly sideFilesPresent: boolean;
  readonly pendingChanges: boolean;
}

export interface HeartbeatEvents {
  /** Server or superseded displacement: the runtime runs displacement (6.6). */
  displaced(reason: DisplacementReason, byDeviceName: string | null, detail?: DisplacedDetail): void;
  /**
   * A re-acquire after reconnect found another holder (6.8 "Reachable again"), or the account's
   * device cap full (plan enforcement S3: holders[0] is the device a take-over would lock).
   */
  reconnectConflict(holders: readonly Holder[], cause?: DenialCause, deviceCap?: number | null): void;
  /** Every confirmed grant or heartbeat `ok` (ownerCheck, owner tag, banners); null ownership is unknown. */
  ownershipConfirmed?(ownership: Ownership | null): void;
  /** Lease became confirmed or unconfirmed (badge, effective limit). */
  leaseChanged(): void;
  /** Server limit changed (plan change, 6.9). */
  limitChanged(limit: number): void;
  /**
   * Every good acquire or heartbeat answer, changed or not (6.8: keeps local.json lastLimit
   * fresh); the lease's session rows were just refreshed.
   */
  limitConfirmed(limit: number): void;
}

export interface HeartbeatDeps {
  readonly ids: SessionIds;
  readonly client: SessionClientPort;
  readonly lease: LeaseTracker;
  readonly host: Pick<SessionHost, 'clock' | 'timers' | 'logger' | 'power' | 'activity' | 'busy'>;
  /** Acquire arguments for re-acquire (takeover and claim always false here: background re-acquires never claim). */
  readonly acquireArgs: () => AcquireArgs;
  readonly context: () => HeartbeatContext;
  readonly events: HeartbeatEvents;
}

export class HeartbeatLoop {
  private running = false;
  private suspended = false;
  /** Bumped by start/stop so answers of an earlier run are not applied. */
  private generation = 0;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<HeartbeatResult | null> | null = null;
  private followUp: Promise<HeartbeatResult | null> | null = null;
  private powerOff: (() => void)[] = [];
  private reportedConfirmed = false;
  private conflictReported = false;

  constructor(private readonly deps: HeartbeatDeps) {}

  /** Starts the 30 s beat (or the 60 s acquire retry when unconfirmed) and power listeners. */
  start(): void {
    if (this.running) {
      this.deps.host.logger.debug(`${P} heartbeat already running`);
      return;
    }
    this.running = true;
    this.suspended = false;
    this.generation++;
    this.conflictReported = false;
    this.reportedConfirmed = this.deps.lease.isConfirmed(this.now());
    const { power } = this.deps.host;
    this.powerOff = [power.onSuspend(() => this.suspend()), power.onResume(() => this.resume())];
    this.scheduleNext(this.now());
    this.deps.host.logger.info(`${P} heartbeat started`, { lease: this.deps.lease.state().kind });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.cancelTimer();
    for (const off of this.powerOff) {
      try {
        off();
      } catch (err) {
        this.deps.host.logger.error(`${P} heartbeat power unsubscribe failed`, { error: errorName(err) });
      }
    }
    this.powerOff = [];
    this.deps.host.logger.info(`${P} heartbeat stopped`);
  }

  /** One heartbeat now (after publish, resume, tests). Single flight. */
  beatNow(): Promise<HeartbeatResult | null> {
    if (!this.running || this.suspended) return Promise.resolve(null);
    return this.runSoon();
  }

  /**
   * The user answered a reconnect conflict but the take-over got no server answer: the next
   * denied retry reports the conflict again instead of leaving this device unconfirmed for good.
   */
  conflictAnswered(): void {
    this.conflictReported = false;
  }

  /** powerMonitor suspend: stop beating; the lease expires after 90 s server-side. */
  suspend(): void {
    if (!this.running || this.suspended) return;
    this.suspended = true;
    this.cancelTimer();
    this.deps.host.logger.info(`${P} heartbeat suspended`);
  }

  /** powerMonitor resume: beat at once; lost/expired leads to a normal acquire. */
  resume(): void {
    if (!this.running || !this.suspended) return;
    this.suspended = false;
    this.deps.host.logger.info(`${P} heartbeat resumed`);
    this.noteLeaseChange();
    void this.runSoon();
  }

  // ---------- Scheduling ----------

  private now(): number {
    return this.deps.host.clock.now();
  }

  private cancelTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /** Coalesces triggers: while a step runs, every further trigger shares one follow-up step. */
  private runSoon(): Promise<HeartbeatResult | null> {
    const current = this.inFlight;
    if (current === null) return this.launch();
    if (this.followUp === null) {
      this.followUp = current.then(() => {
        this.followUp = null;
        return this.launch();
      });
    }
    return this.followUp;
  }

  private launch(): Promise<HeartbeatResult | null> {
    if (!this.running || this.suspended) return Promise.resolve(null);
    this.cancelTimer();
    const gen = this.generation;
    const startedMs = this.now();
    const run: Promise<HeartbeatResult | null> = this.step(gen).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
      if (gen === this.generation && this.followUp === null) this.scheduleNext(startedMs);
    });
    this.inFlight = run;
    return run;
  }

  /** Next beat HEARTBEAT_MS (or acquire OFFLINE_RETRY_MS) after `fromMs`; nothing when displaced or signed out. */
  private scheduleNext(fromMs: number): void {
    this.cancelTimer();
    if (!this.running || this.suspended) return;
    const action = actionFor(this.deps.lease.state());
    if (action.kind === 'idle') return;
    const period = action.kind === 'beat' ? HEARTBEAT_MS : OFFLINE_RETRY_MS;
    const delay = Math.max(0, fromMs + period - this.now());
    this.timer = this.deps.host.timers.setTimeout(() => {
      this.timer = null;
      void this.runSoon();
    }, delay);
  }

  // ---------- Steps ----------

  private async step(gen: number): Promise<HeartbeatResult | null> {
    try {
      const action = actionFor(this.deps.lease.state());
      if (action.kind === 'beat') return await this.beat(action.leaseId, gen);
      if (action.kind === 'acquire') await this.acquire(gen);
      return null;
    } catch (err) {
      this.deps.host.logger.error(`${P} heartbeat step failed`, { error: errorName(err) });
      return null;
    }
  }

  private async beat(leaseId: string, gen: number): Promise<HeartbeatResult> {
    const { lease } = this.deps;
    const marker = lease.markerToSend();
    const args = heartbeatArgs({ ids: this.deps.ids, leaseId, marker, host: this.deps.host, context: this.deps.context });
    const result = await this.callHeartbeat(args);
    if (marker !== null && acknowledgesMarker(result)) lease.markerAcknowledged(marker);
    if (gen !== this.generation) {
      this.deps.host.logger.debug(`${P} heartbeat answer after stop ignored`, { result: result.kind });
      return result;
    }
    const prevLimit = lease.serverLimit();
    lease.onHeartbeat(result, this.now());
    this.noteLeaseChange();
    await this.onHeartbeatResult(result, prevLimit, gen);
    return result;
  }

  private async onHeartbeatResult(result: HeartbeatResult, prevLimit: number | null, gen: number): Promise<void> {
    const { logger } = this.deps.host;
    if (result.kind === 'ok') {
      this.noteLimit(prevLimit, result.limit);
      this.noteOwnership(result.ownership);
    } else if (result.kind === 'displaced') {
      logger.info(`${P} lease displaced by the server`, { reason: result.reason });
      const detail: DisplacedDetail = { minVersion: result.minVersion, released: result.released };
      this.emit('displaced', () => this.deps.events.displaced(result.reason, result.byDeviceName, detail));
    } else if (result.kind === 'lost' && result.reason === 'superseded') {
      logger.warn(`${P} lease superseded by another running copy with this device identity`);
      this.emit('displaced', () => this.deps.events.displaced('superseded', null));
    } else if (result.kind === 'lost') {
      logger.info(`${P} lease lost; acquiring again`, { reason: result.reason });
      await this.acquire(gen);
    }
  }

  private async acquire(gen: number): Promise<void> {
    const args = this.buildAcquireArgs();
    if (args === null) return;
    const result = await this.callAcquire(args);
    if (gen !== this.generation) {
      if (result.kind === 'granted') await this.releaseOrphan(result.leaseId);
      return;
    }
    const { lease } = this.deps;
    const prevLimit = lease.serverLimit();
    lease.onAcquire(result, this.now());
    this.noteLeaseChange();
    if (result.kind === 'granted') {
      this.deps.host.logger.info(`${P} lease acquired`);
      this.noteLimit(prevLimit, result.limit);
      this.noteOwnership(result.ownership);
    } else if (result.kind === 'denied') {
      this.reportConflict(result.holders, result.cause, result.deviceCap);
    } else if (result.kind === 'not-owner') {
      this.deps.host.logger.info(`${P} re-acquire refused: the vault belongs to another account`);
      const detail: DisplacedDetail = { minVersion: null, released: result.released };
      this.emit('displaced', () => this.deps.events.displaced('not_owner', null, detail));
    } else if (result.kind === 'update-required') {
      this.deps.host.logger.info(`${P} re-acquire refused: this version is below the minimum`);
      const detail: DisplacedDetail = { minVersion: result.minVersion, released: false };
      this.emit('displaced', () => this.deps.events.displaced('update_required', null, detail));
    }
  }

  /** A grant that arrived after stop() belongs to nobody: give the slot back instead of holding it for 90 s. */
  private async releaseOrphan(leaseId: string): Promise<void> {
    const ctx = readContext(this.deps.context, this.deps.host.logger);
    try {
      const res = await this.deps.client.release({ ...this.idsOnly(), leaseId, marker: null, pending: ctx?.pendingChanges ?? false });
      this.deps.host.logger.info(`${P} released a lease granted after the heartbeat stopped`, { result: res.kind });
    } catch (err) {
      this.deps.host.logger.error(`${P} release of a late grant threw`, { error: errorName(err) });
    }
  }

  private reportConflict(holders: readonly Holder[], cause: DenialCause, deviceCap: number | null): void {
    if (this.conflictReported) {
      this.deps.host.logger.debug(`${P} vault still open on another device`);
      return;
    }
    this.conflictReported = true;
    this.deps.host.logger.info(`${P} vault open on another device after reconnect`, { holders: holders.length, cause });
    this.emit('reconnectConflict', () => this.deps.events.reconnectConflict(holders, cause, deviceCap));
  }

  // ---------- Events ----------

  private noteLeaseChange(): void {
    const confirmed = this.deps.lease.isConfirmed(this.now());
    if (confirmed) this.conflictReported = false;
    if (confirmed === this.reportedConfirmed) return;
    this.reportedConfirmed = confirmed;
    this.deps.host.logger.info(`${P} lease ${confirmed ? 'confirmed' : 'unconfirmed'}`);
    this.emit('leaseChanged', () => this.deps.events.leaseChanged());
  }

  private noteOwnership(ownership: Ownership | null): void {
    const handler = this.deps.events.ownershipConfirmed;
    if (handler !== undefined) this.emit('ownershipConfirmed', () => handler.call(this.deps.events, ownership));
  }

  private noteLimit(prev: number | null, next: number): void {
    this.emit('limitConfirmed', () => this.deps.events.limitConfirmed(next));
    if (prev === next) return;
    this.deps.host.logger.info(`${P} server limit changed`, { limit: next });
    this.emit('limitChanged', () => this.deps.events.limitChanged(next));
  }

  private emit(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.host.logger.error(`${P} heartbeat ${name} handler failed`, { error: errorName(err) });
    }
  }

  // ---------- Arguments and calls ----------

  private idsOnly(): SessionIds {
    return { vaultKey: this.deps.ids.vaultKey, deviceId: this.deps.ids.deviceId };
  }

  private buildAcquireArgs(): AcquireArgs | null {
    try {
      return { ...this.deps.acquireArgs(), takeover: false, claim: false };
    } catch (err) {
      this.deps.host.logger.error(`${P} acquire arguments unavailable`, { error: errorName(err) });
      return null;
    }
  }

  private async callHeartbeat(args: HeartbeatArgs): Promise<HeartbeatResult> {
    try {
      return await this.deps.client.heartbeat(args);
    } catch (err) {
      this.deps.host.logger.error(`${P} heartbeat call threw`, { error: errorName(err) });
      return { kind: 'unconfirmed', reason: 'network', detail: 'client threw' };
    }
  }

  private async callAcquire(args: AcquireArgs): Promise<AcquireResult> {
    try {
      return await this.deps.client.acquire(args);
    } catch (err) {
      this.deps.host.logger.error(`${P} acquire call threw`, { error: errorName(err) });
      return { kind: 'unconfirmed', reason: 'network', detail: 'client threw' };
    }
  }
}
