/**
 * The running session of one open personal vault (spec 6.2, 6.4, 6.6-6.11): owns the lease
 * tracker, heartbeat, Realtime, stale wait, claims evaluation and displacement, implements the
 * engine's SessionSignals bridge (never calling the engine synchronously), keeps the offline
 * badge and local.json lastLimit, and runs the release points: lock and quit (final cycle with
 * a 3 s cap, presence session_open = 0 with a publish, vault_session_release with the marker
 * and pending flag), sign-out, and the reconnect conflict (the heartbeat follows suspend and
 * resume itself). Private vaults run the same without replica and engine (lease and presence
 * of the lease only).
 * Parts: session-runtime-parts.ts (pure helpers), session-runtime-close.ts (release points),
 * session-runtime-links.ts (heartbeat, Realtime, stale wait), session-runtime-claims.ts (6.7).
 */

import type { ReplicaPort } from '../sync/replica.js';
import type { FinalKind, SyncEngine } from '../sync/sync-engine.js';
import type { SessionSignals, TimerHandle } from '../sync/host.js';
import type { AppDot } from '../sync/types.js';
import { Displacement } from './displacement.js';
import type { EffectiveLimit } from './effective-limit.js';
import type { HeartbeatLoop } from './heartbeat.js';
import type { LeaseTracker } from './lease.js';
import type { SessionRealtime } from './realtime.js';
import { QUIT_RELEASE_TIMEOUT_MS, RPC_TIMEOUT_MS, type AcquireResult, type SessionClientPort, type SessionIds } from './session-client.js';
import type { StaleWait } from './stale-wait.js';
import type { DisplacementReason, Holder, SessionConfig, SessionHost } from './host.js';
import { ClaimsWatch, writeOwnerClaim } from './session-runtime-claims.js';
import { closeWorkingCopy, releaseLease, runFinalCycle, stopRunning, teardown, type CloseParts } from './session-runtime-close.js';
import { startServerLinks, startStaleWait } from './session-runtime-links.js';
import { P, acquireArgsFor, factsFromHint, guarded, readOr, recordLastLimit, runtimeEffectiveLimit, uncoveredSideFilesFlag, type FileFacts } from './session-runtime-parts.js';

export { SERVER_SIDE_FILES_WINDOW_MS } from './session-runtime-parts.js';

export interface RuntimeDeps {
  readonly host: SessionHost;
  readonly config: SessionConfig;
  readonly lineageId: string;
  readonly shared: boolean;
  readonly fileName: string | null;
  readonly client: SessionClientPort;
  readonly lease: LeaseTracker;
  /** null for private vaults. */
  readonly replica: ReplicaPort | null;
}

export interface ReleaseOutcome {
  /** The final cycle published (or S already covered W). */
  readonly published: boolean;
  readonly pendingPublish: boolean;
  /** vault_session_release got an answer (false offline or signed out). */
  readonly released: boolean;
}

export type ConflictChoice = 'use-here' | 'lock-here';

export class PersonalVaultRuntime {
  private engine: SyncEngine | null = null;
  private heartbeat: HeartbeatLoop | null = null;
  private realtime: SessionRealtime | null = null;
  private staleWait: StaleWait | null = null;
  private readonly displacement: Displacement;
  private readonly ids: SessionIds;
  private closing = false;
  private closed: Promise<ReleaseOutcome> | null = null;
  private sideFilesPresent = false;
  /** The server side-file flag as of the last session rows (a cycle runs when it clears). */
  private serverFlagSeen = false;
  private conflictHolders: readonly Holder[] = [];
  private readonly claims: ClaimsWatch;
  private beatTimer: TimerHandle | null = null;
  private signOutRelease: Promise<void> | null = null;

  constructor(private readonly deps: RuntimeDeps) {
    this.ids = { vaultKey: deps.lineageId, deviceId: deps.config.deviceUuid };
    this.claims = new ClaimsWatch({
      host: deps.host,
      shared: deps.shared,
      ownDeviceUuid: deps.config.deviceUuid,
      lease: deps.lease,
      effectiveLimit: () => this.effectiveLimit().limit,
      inactive: () => this.inactive(),
      displace: (by) => void this.displace('owner_claim', by),
      current: () => deps.replica?.state() ?? null,
      inLane: (fn) => (this.engine === null ? Promise.resolve().then(fn) : this.engine.exclusive(fn)),
    });
    this.displacement = new Displacement({
      lineageId: deps.lineageId,
      fileName: deps.fileName,
      host: deps.host,
      finalSync: deps.shared ? () => runFinalCycle(this.parts(), 'displaced') : null,
      release: async (pending) => {
        await releaseLease(this.parts(), pending, RPC_TIMEOUT_MS);
      },
      teardown: () => this.teardownAll(),
    });
  }

  /** The bridge handed to assembleSyncEngine (valid before attachEngine). */
  signals(): SessionSignals {
    return {
      softLocked: () => this.displacement.softLocked(),
      serverSideFilesFlagRecent: (nowMs) => this.serverSideFilesFlag(nowMs),
      sessions: () => this.deps.lease.sessions(),
      sessionOpen: () => !this.closing,
      afterMerge: () => this.claims.schedule(),
      published: (marker) => this.onPublished(marker),
      sharedRead: (state) => guarded(this.deps.host.logger, 'stale wait read', () => this.staleWait?.onSharedRead(state)),
      sideFilesChanged: (present) => {
        this.sideFilesPresent = present;
        this.beatSoon();
      },
    };
  }

  /** Shared vaults: the engine built from signals(); its parts().status carries the badge and waiting state. */
  attachEngine(engine: SyncEngine): void {
    this.engine = engine;
  }

  /**
   * Starts heartbeat (signed in) or the 60 s acquire retry (unconfirmed), Realtime, and the
   * stale wait for markers uncovered by the first read. `acquire` is openPersonalVault's result
   * (null when signed out or skipped).
   */
  start(acquire: AcquireResult | null): void {
    const { host, lease, replica } = this.deps;
    if (acquire !== null) lease.onAcquire(acquire, host.clock.now());
    if (acquire?.kind === 'granted') recordLastLimit(replica, host, acquire.limit);
    this.serverFlagSeen = this.serverSideFilesFlag(host.clock.now());
    const signedIn = host.account.userId() !== null;
    if (signedIn) this.linkServer();
    this.updateBadge();
    const engine = this.engine;
    if (this.deps.shared && engine !== null && replica !== null) {
      const limit = (): number => this.effectiveLimit().limit;
      this.staleWait = startStaleWait({ host, ids: this.ids, client: this.deps.client, engine, replica, acquire, signedIn, limit });
    }
    this.claims.arm();
    host.logger.info(`${P} runtime started`, { shared: this.deps.shared, signedIn, lease: lease.state().kind });
  }

  effectiveLimit(): EffectiveLimit {
    return runtimeEffectiveLimit(this.deps.host, this.deps.lease, this.deps.replica);
  }

  /** 6.4 lockVaultFromMain: final cycle (3 s cap) with session_open = 0, release, stop, close W. */
  lock(): Promise<ReleaseOutcome> {
    return this.close('lock', RPC_TIMEOUT_MS);
  }

  /** 6.4 before-quit: the same bounded flush and release (QUIT_RELEASE_TIMEOUT_MS on the RPC). */
  quit(): Promise<ReleaseOutcome> {
    return this.close('quit', QUIT_RELEASE_TIMEOUT_MS);
  }

  /**
   * 6.8 reconnect conflict answer: 'use-here' acquires with takeover; 'lock-here' displaces now.
   * Ignored while closing or locked (after a soft lock, [Use here instead] is a fresh open).
   */
  async answerConflict(choice: ConflictChoice): Promise<void> {
    if (this.inactive()) {
      this.deps.host.logger.info(`${P} conflict answer ignored: the vault is closing or locked`, { choice });
      return;
    }
    if (choice === 'lock-here') {
      await this.displace('yielded', this.conflictHolders[0]?.deviceName ?? null);
      return;
    }
    const { client, lease, host } = this.deps;
    const result = await client.acquire(acquireArgsFor(host, { ...this.ids, sessionNonce: this.deps.config.sessionNonce, facts: this.facts(), takeover: true }));
    lease.onAcquire(result, host.clock.now());
    this.updateBadge();
    if (result.kind === 'unconfirmed') return this.takeoverUnconfirmed(result.reason);
    if (result.kind !== 'granted') {
      host.logger.warn(`${P} take-over after reconnect not granted; the conflict stays open`, { result: result.kind });
      return;
    }
    this.endConflict();
    recordLastLimit(this.deps.replica, host, result.limit);
    await writeOwnerClaim(host, this.deps.replica, this.engine, this.effectiveLimit().limit);
    void this.heartbeat?.beatNow();
  }

  /** Displacement from any source (heartbeat, Realtime, claims, conflict timeout). */
  async displace(reason: DisplacementReason, byDeviceName: string | null): Promise<void> {
    this.closing = true;
    this.cancelTimers();
    await this.displacement.displace(reason, byDeviceName);
  }

  /** 6.11 [Open now]. */
  openNow(): void {
    guarded(this.deps.host.logger, 'open now', () => this.staleWait?.openNow());
  }

  /** 6.11 [Stop waiting for X]. */
  async stopWaiting(deviceId: string): Promise<void> {
    await this.staleWait?.stopWaiting(deviceId);
  }

  /**
   * Signed out mid-session: release the lease (bounded), switch to claims (limit 1). The release
   * runs once: the explicit sign-out calls this while the session can still reach the server,
   * and the auth-state hook calls it again once the account is gone (which refreshes the badge).
   */
  async signedOut(): Promise<void> {
    this.signOutRelease ??= this.releaseForSignOut();
    await this.signOutRelease;
    this.updateBadge();
  }

  isSoftLocked(): boolean {
    return this.displacement.softLocked();
  }

  private async releaseForSignOut(): Promise<void> {
    const pending = this.pendingPublish();
    // Stopped before the release: a beat answered 'released' mid-release would acquire a lease nobody frees.
    guarded(this.deps.host.logger, 'heartbeat stop', () => this.heartbeat?.stop());
    guarded(this.deps.host.logger, 'realtime stop', () => this.realtime?.stop());
    this.displacement.cancelReconnectTimer();
    await releaseLease(this.parts(), pending, RPC_TIMEOUT_MS);
    this.deps.lease.signedOut();
    this.deps.host.logger.info(`${P} signed out: the lease was released; owner claims apply`);
  }

  // ---------- start ----------

  private linkServer(): void {
    const { host, config, client, lease } = this.deps;
    const links = startServerLinks({
      host,
      config,
      ids: this.ids,
      client,
      lease,
      facts: () => this.facts(),
      sideFilesPresent: () => this.sideFilesPresent,
      pendingPublish: () => this.pendingPublish(),
      events: {
        displaced: (reason, by) => void this.displace(reason, by),
        reconnectConflict: (holders) => this.onReconnectConflict(holders),
        leaseChanged: () => this.onLeaseChanged(),
        limitChanged: () => this.claims.schedule(),
        limitConfirmed: (limit) => {
          recordLastLimit(this.deps.replica, host, limit);
          this.onSessionsRefreshed();
        },
      },
      onDisplaced: (reason, by) => void this.displace(reason, by),
    });
    this.heartbeat = links.heartbeat;
    this.realtime = links.realtime;
  }

  // ---------- events ----------

  private onReconnectConflict(holders: readonly Holder[]): void {
    if (this.inactive()) return this.deps.host.logger.debug(`${P} reconnect conflict ignored: the vault is closing or locked`);
    this.conflictHolders = holders;
    const answerByMs = this.displacement.armReconnectTimer(holders[0]?.deviceName ?? null);
    guarded(this.deps.host.logger, 'conflict event', () =>
      this.deps.host.sessionEvents.emit('vault:session-conflict', { lineageId: this.deps.lineageId, holders, answerByMs }),
    );
  }

  /** 5.5: publishing held only by the server flag resumes when it clears, not at the next safety poll. */
  private onSessionsRefreshed(): void {
    const seen = this.serverSideFilesFlag(this.deps.host.clock.now());
    const cleared = this.serverFlagSeen && !seen;
    this.serverFlagSeen = seen;
    if (cleared && !this.inactive()) guarded(this.deps.host.logger, 'side-file flag cleared', () => this.engine?.trigger('session-hint'));
  }

  private serverSideFilesFlag(nowMs: number): boolean {
    return uncoveredSideFilesFlag(this.deps.lease, this.deps.replica, this.deps.host.logger, nowMs);
  }

  private onLeaseChanged(): void {
    if (this.deps.lease.isConfirmed(this.deps.host.clock.now())) this.endConflict();
    this.updateBadge();
  }

  private endConflict(): void {
    this.displacement.cancelReconnectTimer();
    this.conflictHolders = [];
  }

  /**
   * 6.3 step 5: a server error is never a denial. The user did answer, so no "unanswered" soft
   * lock; the device stays unconfirmed (claims apply) and the next denied retry asks again.
   */
  private takeoverUnconfirmed(reason: string): void {
    this.endConflict();
    guarded(this.deps.host.logger, 'conflict re-arm', () => this.heartbeat?.conflictAnswered());
    this.deps.host.logger.warn(`${P} take-over after reconnect got no server answer; continuing unconfirmed`, { reason });
  }

  private onPublished(marker: AppDot): void {
    this.deps.lease.markerPublished(marker);
    this.beatSoon();
  }

  /** A heartbeat soon, never synchronously inside the engine's call. */
  private beatSoon(): void {
    if (this.heartbeat === null || this.closing || this.beatTimer !== null) return;
    this.beatTimer = this.deps.host.timers.setTimeout(() => {
      this.beatTimer = null;
      void this.heartbeat?.beatNow();
    }, 0);
  }

  // ---------- state helpers ----------

  private facts(): FileFacts {
    const hint = readOr(this.deps.host.logger, 'file hint', () => this.engine?.parts().binding.fileHint() ?? null, null);
    return factsFromHint(hint, this.deps.fileName);
  }

  private pendingPublish(): boolean {
    return readOr(this.deps.host.logger, 'pending flag', () => this.deps.replica?.local().pendingPublish ?? false, false);
  }

  /** Offline badge (shared vaults, signed in, lease not confirmed). */
  private updateBadge(): void {
    const status = this.engine?.parts().status;
    if (!this.deps.shared || status === undefined) return;
    const { host, lease } = this.deps;
    const offline = host.account.userId() !== null && !lease.isConfirmed(host.clock.now()) && !this.closing;
    guarded(host.logger, 'session badge', () => status.setSessionBadge(offline ? 'offline-device-check' : null));
  }

  private parts(): CloseParts {
    return {
      host: this.deps.host,
      ids: this.ids,
      client: this.deps.client,
      lease: this.deps.lease,
      replica: this.deps.replica,
      engine: this.engine,
      heartbeat: this.heartbeat,
      realtime: this.realtime,
      staleWait: this.staleWait,
    };
  }

  /** Closing, displacing or soft-locked: no lease action, claims check or displacement starts. */
  private inactive(): boolean {
    return this.closing || this.displacement.inProgress() || this.displacement.softLocked();
  }

  private cancelTimers(): void {
    this.claims.cancel();
    this.beatTimer?.cancel();
    this.beatTimer = null;
  }

  private async teardownAll(): Promise<void> {
    this.cancelTimers();
    await teardown(this.parts());
  }

  // ---------- lock and quit (6.4, 7.5) ----------

  private close(kind: FinalKind, releaseTimeoutMs: number): Promise<ReleaseOutcome> {
    if (this.closed === null) this.closed = this.runClose(kind, releaseTimeoutMs);
    return this.closed;
  }

  private async runClose(kind: FinalKind, releaseTimeoutMs: number): Promise<ReleaseOutcome> {
    const { host, lease } = this.deps;
    const displacing = this.displacement.settled();
    if (displacing !== null) {
      // The displaced save publishes and releases (6.6 steps 2-3); the caller closes W only after it.
      const outcome = await displacing;
      return { published: outcome.changesSaved, pendingPublish: !outcome.changesSaved, released: false };
    }
    this.closing = true;
    this.cancelTimers();
    this.displacement.cancelReconnectTimer();
    guarded(host.logger, 'stale wait', () => this.staleWait?.dispose());
    const final = await runFinalCycle(this.parts(), kind);
    await stopRunning(this.parts());
    this.displacement.cancelReconnectTimer();
    const released = await releaseLease(this.parts(), final.pendingPublish, releaseTimeoutMs);
    guarded(host.logger, 'lease released', () => lease.onReleased());
    closeWorkingCopy(this.parts());
    const published = final.published || !final.pendingPublish;
    host.logger.info(`${P} vault closed`, { kind, published, released });
    return { published, pendingPublish: final.pendingPublish, released };
  }
}
