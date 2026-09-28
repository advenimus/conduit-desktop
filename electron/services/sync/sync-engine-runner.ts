/**
 * The engine's loop around the 5.6 cycle body: the lane and single flight, the triggers and
 * their timers, the error back-off, publish verification (covers at +15/+60 s, settling the
 * regression back-off), status around every cycle, the final cycle with its cap, and start/stop.
 * SyncEngine (sync-engine.ts) is the public face; user actions run through exclusive().
 */

import path from 'node:path';
import { COPY_SCAN_INTERVAL_MS, type CopyScanResult } from './copy-scanner.js';
import { Backoff, PublishVerifier, RegressionTracker } from './sync-verify.js';
import { runSyncCycle, type CycleEnv, type CycleMemory } from './sync-cycle.js';
import { STOPPED, checkCycleAlive, runCycleBody, type CycleBody } from './sync-engine-body.js';
import { TornTracker } from './shared-file.js';
import { CycleGate, Lane, SingleFlight } from './sync-engine-lane.js';
import { EngineTimers, raceTimeout } from './sync-engine-timers.js';
import { factsForOutcome, inErrorBackoff, isSettled, planAfter } from './sync-engine-outcome.js';
import { refreshPresence, writeClosingPresence } from './sync-engine-presence.js';
import { EpisodeToastGate, tapSession } from './sync-engine-taps.js';
import { applyScan } from './sync-engine-copies.js';
import { VerifySchedule } from './sync-engine-verify.js';
import { boundFileName, counters, errMeta, guarded, guardedValue, persistPending, readPending } from './sync-engine-local.js';
import { SideFileRetrier, WatcherLink, housekeeping, makeWatchListener, noteNetworkRoot, pruneIncoming, showSideFiles } from './sync-engine-watch.js';
import type { FileWatcherPort } from './file-watch.js';
import { afterPublishSeal } from './password-local-copies.js';
import {
  DISPLACED_FINAL_CYCLE_CAP_MS,
  ERROR_BACKOFF_MAX_MS,
  ERROR_BACKOFF_START_MS,
  FINAL_CYCLE_CAP_MS,
  LOCAL_EDIT_IDLE_MS,
  LOCAL_EDIT_MAX_MS,
  SAFETY_POLL_MS,
} from './sync-engine-constants.js';
import type { CycleOutcome, DirectPublishRecord, FinalKind, FinalOutcome, RunOptions, SyncEngineDeps, SyncEngineSeams, SyncTrigger } from './sync-engine-types.js';
import type { StatusPatch } from './sync-status.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { AppDot, SyncState } from './types.js';

export class EngineRunner {
  readonly memory: CycleMemory = { lastShared: null, missingProbed: null, unsyncedOps: 0, lastPublishMs: null };
  readonly openedAtMs: number;
  private readonly lane = new Lane();
  private readonly gate: CycleGate;
  private readonly scans: SingleFlight<CopyScanResult>;
  private readonly timers: EngineTimers;
  private readonly torn: TornTracker;
  private readonly verifier: PublishVerifier;
  private readonly regressions: RegressionTracker;
  private readonly errorBackoff: Backoff;
  private readonly body: CycleBody;
  private readonly toastGate: EpisodeToastGate;
  private readonly verify: VerifySchedule;
  /** What the cycle sees: the same ports, with the session and notices taps. */
  readonly cycleDeps: SyncEngineDeps;
  private readonly watcher: WatcherLink;
  /** The port WatcherLink opened: WatcherLink acknowledges snapshots only, not an absent or unread S. */
  private watchPort: FileWatcherPort | null = null;
  private readonly sideFileRetry: SideFileRetrier;
  private unsubscribers: (() => void)[] = [];
  private started = false;
  private stopped = false;
  private closing = false;
  private closingPresenceDue = false;
  private finalDeadlineMs: number | null = null;
  private abandoned = false;
  private ownWrite = false;
  private lastOutcome: CycleOutcome | null = null;
  private marker: AppDot | null = null;
  private sharedState: SyncState | null = null;
  private sharedReads = 0;

  constructor(
    private readonly deps: SyncEngineDeps,
    seams: SyncEngineSeams,
  ) {
    const { host } = deps;
    this.openedAtMs = host.clock.now();
    this.gate = new CycleGate(this.lane, (reason, deadline) => this.executeCycle(reason, deadline));
    this.scans = new SingleFlight(this.lane);
    const createWatcher: SyncEngineDeps['createWatcher'] = (sharedPath, listener) => {
      this.watchPort = deps.createWatcher(sharedPath, listener);
      return this.watchPort;
    };
    this.watcher = new WatcherLink({ ...deps, createWatcher });
    this.sideFileRetry = new SideFileRetrier(deps, (fn) => this.exclusive(fn), () => this.fire('sync-now'));
    this.timers = new EngineTimers(host.clock, host.timers, { idleMs: LOCAL_EDIT_IDLE_MS, maxMs: LOCAL_EDIT_MAX_MS });
    this.torn = seams.torn ?? new TornTracker();
    this.verifier = seams.verifier ?? new PublishVerifier();
    this.regressions = seams.regressions ?? new RegressionTracker();
    this.errorBackoff = seams.errorBackoff ?? new Backoff(ERROR_BACKOFF_START_MS, ERROR_BACKOFF_MAX_MS);
    this.body = seams.runCycleBody ?? runSyncCycle;
    const session = tapSession(deps.session, (state) => {
      this.sharedState = state;
      this.sharedReads += 1;
    });
    this.toastGate = new EpisodeToastGate(deps.notices);
    this.cycleDeps = { ...deps, session, notices: this.toastGate.port };
    this.verify = new VerifySchedule({
      verifier: this.verifier,
      regressions: this.regressions,
      timers: this.timers,
      logger: host.logger,
      runVerifyCycle: () => this.runCycle('verify'),
      active: () => !this.stopped && !this.closing,
      sharedReads: () => this.sharedReads,
      sharedState: () => this.sharedState,
    });
  }

  // ---------- lifecycle ----------

  start(): void {
    if (this.stopped) throw new Error(`${SYNC_LOG_PREFIX} engine already stopped`);
    if (this.started) return;
    this.started = true;
    const { replica, binding } = this.deps;
    this.unsubscribers.push(replica.onLocalCommit(() => this.onLocalEdit()));
    this.unsubscribers.push(replica.onFullPassRequest((reason) => this.onFullPassRequest(reason)));
    this.unsubscribers.push(binding.onChange((b) => this.onBindingChange(b.sharedPath)));
    const retrySideFiles = (): void => (this.closing ? undefined : this.sideFileRetry.request());
    const hooks = { deps: this.deps, fire: (t: SyncTrigger) => this.fire(t), requestScan: () => this.requestScan(), alive: () => !this.stopped, retrySideFiles };
    this.watcher.open(binding.sharedPath(), makeWatchListener(hooks), this.memory.lastShared);
    this.timers.startInterval(SAFETY_POLL_MS, () => this.onSafetyPoll());
    this.timers.startInterval(COPY_SCAN_INTERVAL_MS, () => this.requestScan());
    this.guard('start status', () => {
      showSideFiles(this.deps, this.deps.sideFiles.view());
      this.status({ networkRoot: noteNetworkRoot(this.deps), ...counters(this.deps, this.memory.unsyncedOps), fileName: boundFileName(this.deps) });
    });
    const keep = this.memory.lastShared === null ? [] : [this.memory.lastShared.sha256];
    void this.exclusive(() => housekeeping(this.deps, keep, () => !this.stopped)).catch((err: unknown) =>
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} start-up cleanup failed`, errMeta(err)),
    );
    this.requestScan();
  }

  /** Stops timers and the watcher; resolves when the lane is idle (not waiting for an abandoned final cycle). */
  async stop(): Promise<void> {
    if (!this.stopped) this.markStopped();
    if (this.abandoned) return;
    await this.lane.whenIdle();
  }

  whenIdle(): Promise<void> {
    return this.lane.whenIdle();
  }

  private markStopped(): void {
    this.stopped = true;
    this.closing = true;
    this.timers.cancelAll();
    this.guard('watcher stop', () => this.watcher.close());
    this.watchPort = null;
    for (const off of this.unsubscribers.splice(0)) this.guard('unsubscribe', off);
    this.status({ cycleRunning: false });
    this.deps.host.logger.info(`${SYNC_LOG_PREFIX} engine stopped`, { lineage: this.deps.replica.lineageId });
  }

  // ---------- triggers and the lane ----------

  trigger(t: SyncTrigger): void {
    if (this.stopped) return;
    if (t === 'local-edit') return this.onLocalEdit();
    if (t === 'full-pass') return this.onFullPassRequest('trigger');
    if (t === 'sync-now') {
      if (!this.closing) void this.syncNow();
      return;
    }
    if (!this.closing) this.fire(t);
  }

  runCycle(reason: SyncTrigger, opts: RunOptions = {}): Promise<CycleOutcome> {
    if (this.stopped) return Promise.resolve(STOPPED);
    return this.gate.request(reason, opts.deadlineMs);
  }

  syncNow(): Promise<CycleOutcome> {
    this.guard('back-off reset', () => this.errorBackoff.reset());
    this.guard('toast episode', () => this.toastGate.userRetry());
    this.timers.clearRetry();
    this.status({ backoffUntilMs: null });
    return this.runCycle('sync-now');
  }

  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(`${SYNC_LOG_PREFIX} engine stopped`));
    return this.lane.run(() => {
      if (this.stopped) throw new Error(`${SYNC_LOG_PREFIX} engine stopped`);
      return fn();
    });
  }

  scanCopies(): Promise<CopyScanResult> {
    return this.scans.request(async () => {
      if (this.stopped) throw new Error(`${SYNC_LOG_PREFIX} engine stopped`);
      const result = await this.deps.scanner.scan();
      const applied = await applyScan(this.deps, result.copies, () => !this.stopped);
      if (!this.stopped) await pruneIncoming(this.deps, this.memory.lastShared);
      if (applied.merged > 0) this.fire('local-edit');
      return result;
    });
  }

  fire(t: SyncTrigger): void {
    if (this.stopped || this.closing) return;
    this.runCycle(t).catch((err: unknown) =>
      this.deps.host.logger.error(`${SYNC_LOG_PREFIX} cycle request failed`, { trigger: t, ...errMeta(err) }),
    );
  }

  private onSafetyPoll(): void {
    if (!inErrorBackoff(this.lastOutcome, this.timers.retryAt())) this.fire('safety-poll');
  }

  private requestScan(): void {
    if (this.stopped || this.closing) return;
    this.scanCopies().catch((err: unknown) =>
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} copy scan failed`, errMeta(err)),
    );
  }

  private onLocalEdit(): void {
    if (this.stopped || this.ownWrite) return;
    this.memory.unsyncedOps += 1;
    this.status({ unsyncedOps: this.memory.unsyncedOps, pendingPublish: true });
    if (!this.closing) this.timers.armLocalEdit(() => this.fire('local-edit'));
  }

  private onFullPassRequest(reason: string): void {
    if (this.stopped || this.closing) return;
    this.exclusive(() => this.deps.replica.fullPass()).then(
      (res) => {
        if (res.changed) this.onLocalEdit();
        this.fire('full-pass');
      },
      (err: unknown) => this.deps.host.logger.error(`${SYNC_LOG_PREFIX} full pass failed`, { reason, ...errMeta(err) }),
    );
  }

  /** Rebind or rename: follow the new path, and rewrite presence when its file hint changed (3.5). */
  private onBindingChange(sharedPath: string): void {
    this.guard('binding change', () => {
      this.watcher.setSharedPath(sharedPath);
      this.deps.sideFiles.setSharedPath(sharedPath);
      this.status({ fileName: path.basename(sharedPath) });
    });
    if (this.stopped || this.closing) return;
    const { session, binding } = this.deps;
    this.exclusive(() =>
      this.ownWrites(() =>
        refreshPresence(this.deps, { sessionOpen: session.sessionOpen(), sessionSinceMs: this.openedAtMs, fileHint: binding.fileHint() }),
      ),
    ).then(
      (changed) => (changed ? this.fire('local-edit') : undefined),
      (err: unknown) => this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} presence refresh failed`, errMeta(err)),
    );
  }

  // ---------- one cycle ----------

  private async executeCycle(reason: SyncTrigger, deadlineMs: number | undefined): Promise<CycleOutcome> {
    if (this.stopped) return STOPPED;
    this.timers.clearLocalEdit();
    this.status({ cycleRunning: true });
    if (this.closing && this.closingPresenceDue) this.writeClosingPresence();
    const readBefore = this.memory.lastShared;
    const outcome = await this.runBody(reason, deadlineMs);
    if (this.stopped) return outcome;
    if (this.memory.lastShared !== readBefore) this.guard('watch acknowledge', () => this.watcher.acknowledgeRead(this.memory.lastShared));
    this.guard('watch acknowledge', () => this.acknowledgeUnread(outcome));
    if (outcome.kind === 'published') await this.acknowledgeOwnPublish(outcome.sha256);
    if (outcome.kind === 'published' && !this.stopped) await afterPublishSeal(this.deps);
    if (!this.stopped) await pruneIncoming(this.deps, this.memory.lastShared);
    if (!this.stopped) this.guard('cycle bookkeeping', () => this.afterCycle(outcome, reason));
    return outcome;
  }

  /**
   * Unacknowledged, the watcher reports the same absence or kill-switch change on every 3 s poll,
   * and each report reruns the cycle with its capture pass (5.9, 8.1).
   */
  private acknowledgeUnread(o: CycleOutcome): void {
    if (o.kind === 'missing') this.watchPort?.acknowledge(null, null);
    else if (o.kind === 'skipped' && o.reason === 'kill-switch') this.watchPort?.acknowledgeObserved();
  }

  private async acknowledgeOwnPublish(sha256: string): Promise<void> {
    const sharedPath = guardedValue(this.deps.host.logger, 'shared path', () => this.deps.binding.sharedPath());
    if (sharedPath !== null) await this.acknowledgePublished(sharedPath, sha256);
  }

  private async runBody(reason: SyncTrigger, deadlineMs: number | undefined): Promise<CycleOutcome> {
    const env: CycleEnv = {
      deps: this.cycleDeps,
      torn: this.torn,
      verifier: this.verifier,
      regressions: this.regressions,
      memory: this.memory,
      checkAlive: () => this.checkAlive(deadlineMs),
      closing: this.closing,
      ownWrites: (fn) => this.ownWrites(fn),
    };
    return runCycleBody(this.body, env, reason, this.deps.host.logger);
  }

  private checkAlive(deadlineMs: number | undefined): void {
    checkCycleAlive({ stopped: this.stopped, nowMs: this.deps.host.clock.now(), deadlineMs, finalDeadlineMs: this.finalDeadlineMs });
  }

  private afterCycle(o: CycleOutcome, reason: SyncTrigger): void {
    this.lastOutcome = o;
    const now = this.deps.host.clock.now();
    const plan = planAfter(o, {
      nowMs: now,
      nextErrorDelayMs: () => this.errorBackoff.next(),
      regressionBlockedUntil: () => this.regressions.blockedUntil(now),
    });
    if (plan.resetErrorBackoff) this.errorBackoff.reset();
    const retryAtMs = this.keepMissingRecheck(o, plan.retryAtMs);
    if (retryAtMs === null) this.timers.clearRetry();
    else if (!this.closing) this.timers.scheduleRetry(retryAtMs, () => this.fire('retry'));
    if (isSettled(o)) this.memory.unsyncedOps = 0;
    if (o.kind === 'published') {
      this.marker = o.marker;
      this.guard('publish verification', () => this.verify.afterCyclePublish(o.sha256));
    }
    this.guard('regression episode', () => this.toastGate.afterCycle(o, this.regressions.blockedUntil(now), boundFileName(this.deps)));
    this.status({
      ...(factsForOutcome(o) ?? {}),
      cycleRunning: false,
      backoffUntilMs: plan.backoffUntilMs,
      ...(isSettled(o) ? { lastSyncedMs: now } : {}),
      ...counters(this.deps, this.memory.unsyncedOps),
    });
    this.deps.host.logger.debug(`${SYNC_LOG_PREFIX} cycle done`, { reason, outcome: o.kind });
  }

  /**
   * 5.9: the watcher stays quiet while S is missing, so the recheck is what ends the 30 s debounce;
   * another cycle during the debounce (local edit, verify, safety poll) must not push it later.
   */
  private keepMissingRecheck(o: CycleOutcome, plannedMs: number | null): number | null {
    const pending = this.timers.retryAt();
    if (o.kind !== 'missing' || plannedMs === null || pending === null) return plannedMs;
    return Math.min(pending, plannedMs);
  }

  /** Records a publish made outside the cycle (new vault, new copy) like the cycle's own. */
  recordDirectPublish(r: DirectPublishRecord): void {
    const now = this.deps.host.clock.now();
    this.memory.unsyncedOps = 0;
    this.memory.lastPublishMs = now;
    this.marker = r.marker;
    this.lastOutcome = { kind: 'published', sha256: r.sha256, marker: r.marker };
    this.guard('publish verification', () =>
      this.verify.afterDirectPublish({ sha256: r.sha256, marker: r.marker, state: r.state, atMs: now }),
    );
    this.guard('session published', () => this.cycleDeps.session.published(r.marker));
    this.status({ lastSyncedMs: now, ...counters(this.deps, this.memory.unsyncedOps) });
  }

  /** After our own publish: the watcher must not report it as a change. */
  acknowledgePublished(filePath: string, sha256: string): Promise<void> {
    return this.watcher.acknowledgePublished(filePath, sha256);
  }

  /** Writes W without counting it as a user edit (presence, markers). */
  ownWrites<T>(fn: () => T): T {
    this.ownWrite = true;
    try {
      return fn();
    } finally {
      this.ownWrite = false;
    }
  }

  // ---------- final cycle (5.6, 6.4, 6.6) ----------

  async finalCycle(kind: FinalKind): Promise<FinalOutcome> {
    if (this.stopped) return this.finalResult(null, false);
    const cap = kind === 'displaced' ? DISPLACED_FINAL_CYCLE_CAP_MS : FINAL_CYCLE_CAP_MS;
    const unpublished = this.memory.unsyncedOps > 0 || !isSettled(this.lastOutcome);
    this.closing = true;
    this.closingPresenceDue = true;
    this.finalDeadlineMs = this.deps.host.clock.now() + cap;
    this.timers.clearCycleTimers();
    if (unpublished) persistPending(this.deps, true);
    const raced = await raceTimeout(this.runCycle('final', { deadlineMs: this.finalDeadlineMs }), cap, this.deps.host.timers);
    if (raced.kind === 'timeout') {
      this.abandoned = true;
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} final cycle hit its cap`, { kind, capMs: cap });
      return this.finalResult(null, true);
    }
    const o = raced.value;
    if (isSettled(o)) persistPending(this.deps, false);
    return this.finalResult(o, o.kind === 'skipped' && o.reason === 'stopped');
  }

  private finalResult(o: CycleOutcome | null, timedOut: boolean): FinalOutcome {
    return { published: o?.kind === 'published', timedOut, pendingPublish: readPending(this.deps), marker: this.marker };
  }

  /** 6.4: session_open = 0 must reach S, so the final cycle has something to publish. */
  private writeClosingPresence(): void {
    this.closingPresenceDue = false;
    this.guard('closing presence', () => writeClosingPresence(this.deps, (fn) => this.ownWrites(fn)));
  }

  // ---------- views ----------

  lastSharedState(): SyncState | null {
    return this.sharedState;
  }

  status(patch: StatusPatch): void {
    this.guard('status', () => this.deps.status.update(patch));
  }

  guard(what: string, fn: () => void): void {
    guarded(this.deps.host.logger, what, fn);
  }
}
