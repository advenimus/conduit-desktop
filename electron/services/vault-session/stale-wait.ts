/**
 * Stale file when moving between devices (spec 6.11, 4.4 G1 wait, 12 rows 8/26/67): expected
 * publish markers are those of sessions with the same file_id, not abandoned server-side and
 * not in this device's abandoned_waits; S is stale while any expected marker is not covered by
 * S.vv. Free: a dialog polling every 2 s that continues on its own when covered, [Open now]
 * from the start, [Stop waiting for X] after 2 minutes (vault_session_abandon); Pro: the same
 * as a banner. A wait that reached 2 minutes uncovered records its markers in abandoned_waits.
 * Also the G1 "Getting the synced vault from MacBook..." wait and the signed-out hint.
 */

import { readPresence, type PresenceEntry } from '../sync/presence.js';
import type { ReplicaPort } from '../sync/replica.js';
import { compareHlc } from '../sync/sibling.js';
import type { SyncStatusPort } from '../sync/sync-status.js';
import type { TimerHandle, WaitingDevice, WaitingState } from '../sync/host.js';
import type { AppDot, SyncState } from '../sync/types.js';
import type { SessionClientPort, SessionIds } from './session-client.js';
import type { SessionHost } from './host.js';
import {
  ABANDONED_WAITS_KEEP,
  STALE_POLL_MS,
  STALE_STOP_OFFER_MS,
  abandonedKey,
  errorMeta,
  sameId,
  setWaitingSafely,
  uncoveredMarkers,
  waitingDevices,
  type ExpectedMarker,
} from './stale-wait-markers.js';

export {
  ABANDONED_WAITS_KEEP,
  G1_WAIT_MS,
  STALE_POLL_MS,
  STALE_STOP_OFFER_MS,
  abandonedKey,
  expectedMarkers,
  uncoveredMarkers,
} from './stale-wait-markers.js';
export type { ExpectedMarker } from './stale-wait-markers.js';
export { signedOutHint, waitForSyncedFile } from './stale-wait-g1.js';
export type { G1WaitInput, SharedProbe } from './stale-wait-g1.js';

function appendAbandoned(existing: readonly string[], keys: readonly string[]): readonly string[] {
  const added = new Set(keys);
  return [...existing.filter((k) => !added.has(k)), ...added].slice(-ABANDONED_WAITS_KEEP);
}

function isNewerDot(next: AppDot | null, prev: AppDot | null): boolean {
  if (next === null) return false;
  if (prev === null) return true;
  const byHlc = compareHlc(next, prev);
  return byHlc > 0 || (byHlc === 0 && next.dev > prev.dev);
}

export type WaitMode = 'dialog' | 'banner';

export interface StaleWaitDeps {
  readonly ids: SessionIds;
  readonly client: Pick<SessionClientPort, 'abandon'>;
  readonly replica: Pick<ReplicaPort, 'local' | 'updateLocal'>;
  readonly status: Pick<SyncStatusPort, 'setWaiting'>;
  readonly host: Pick<SessionHost, 'clock' | 'timers' | 'logger'>;
  /** Asks the engine to re-read S (a cycle); the result arrives through onSharedRead. */
  readonly requestRead: () => void;
}

type Phase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'markers';
      readonly markers: readonly ExpectedMarker[];
      readonly mode: WaitMode;
      readonly sinceMs: number;
      readonly stopOffered: boolean;
    }
  | { readonly kind: 'signed-out'; readonly entry: PresenceEntry; readonly sinceMs: number; readonly stopOffered: boolean };

const IDLE: Phase = Object.freeze({ kind: 'idle' });

export class StaleWait {
  private phase: Phase = IDLE;
  private poll: TimerHandle | null = null;
  private stopOffer: TimerHandle | null = null;

  constructor(private readonly deps: StaleWaitDeps) {}

  /** Starts waiting for `uncovered` (no-op and false when empty); status 'waiting'. */
  begin(uncovered: readonly ExpectedMarker[], mode: WaitMode): boolean {
    if (uncovered.length === 0) return false;
    this.clearTimers();
    this.phase = { kind: 'markers', markers: [...uncovered], mode, sinceMs: this.deps.host.clock.now(), stopOffered: false };
    this.deps.host.logger.info('[vault-session] stale wait started', { markers: uncovered.length, mode });
    this.showWaiting();
    this.startPolling();
    this.stopOffer = this.deps.host.timers.setTimeout(() => this.offerStop(), STALE_STOP_OFFER_MS);
    return true;
  }

  /**
   * 6.11 signed out: waits on `entry`'s device ([Wait] [Use here]); ends when a later S shows
   * that device with session_open = 0 or a newer presence dot, or on openNow().
   */
  beginSignedOut(entry: PresenceEntry): void {
    this.clearTimers();
    this.phase = { kind: 'signed-out', entry, sinceMs: this.deps.host.clock.now(), stopOffered: false };
    this.deps.host.logger.info('[vault-session] signed-out stale hint shown');
    this.showWaiting();
    this.startPolling();
    this.stopOffer = this.deps.host.timers.setTimeout(() => this.offerStop(), STALE_STOP_OFFER_MS);
  }

  /** Every S read: drops covered markers; ends the wait when none remain. */
  onSharedRead(state: SyncState): void {
    const phase = this.phase;
    if (phase.kind === 'markers') {
      const remaining = uncoveredMarkers(phase.markers, state.vv);
      if (remaining.length === phase.markers.length) return;
      this.replaceMarkers(phase, remaining, 'covered');
    } else if (phase.kind === 'signed-out' && this.peerSettled(state, phase.entry)) {
      this.end('peer-settled');
    }
  }

  /** [Open now]: ends the wait (always safe: a late file merges when it arrives). */
  openNow(): void {
    if (this.phase.kind !== 'idle') this.end('open-now');
  }

  /** [Stop waiting for X]: vault_session_abandon, abandoned_waits, drop that device's markers. */
  async stopWaiting(deviceId: string): Promise<void> {
    const phase = this.phase;
    if (phase.kind === 'signed-out') {
      if (sameId(phase.entry.deviceUuid, deviceId)) this.end('stopped');
      return;
    }
    if (phase.kind !== 'markers') return;
    this.replaceMarkers(phase, phase.markers.filter((m) => !sameId(m.deviceId, deviceId)), 'stopped');
    await this.abandon(deviceId);
  }

  active(): boolean {
    return this.phase.kind !== 'idle';
  }

  dispose(): void {
    if (this.phase.kind !== 'idle') this.end('disposed');
    else this.clearTimers();
  }

  private replaceMarkers(phase: Phase & { kind: 'markers' }, remaining: readonly ExpectedMarker[], why: string): void {
    if (remaining.length === 0) {
      this.end(why);
      return;
    }
    this.phase = { ...phase, markers: remaining };
    this.showWaiting();
  }

  private peerSettled(state: SyncState, entry: PresenceEntry): boolean {
    try {
      const now = readPresence(state, entry.deviceUuid);
      if (now === null) return false;
      return now.value.session_open === 0 || isNewerDot(now.dot, entry.dot);
    } catch (err) {
      this.deps.host.logger.warn('[vault-session] presence read failed during the stale hint', errorMeta(err));
      return false;
    }
  }

  private async abandon(deviceId: string): Promise<void> {
    const { logger } = this.deps.host;
    try {
      const res = await this.deps.client.abandon({ ...this.deps.ids, targetDeviceId: deviceId });
      if (res.kind === 'unconfirmed') logger.warn('[vault-session] abandon not confirmed', { reason: res.reason, detail: res.detail });
    } catch (err) {
      logger.error('[vault-session] abandon failed', errorMeta(err));
    }
  }

  private offerStop(): void {
    this.stopOffer = null;
    const phase = this.phase;
    if (phase.kind === 'idle') return;
    // A marker the drive may never deliver (12 row 8), or a peer that never publishes again,
    // must not cost a full read every 2 s for days; the engine's watcher and safety poll still
    // report every read, so a later S ends the wait.
    this.poll?.cancel();
    this.poll = null;
    this.phase = { ...phase, stopOffered: true };
    if (phase.kind === 'signed-out') {
      this.deps.host.logger.info('[vault-session] signed-out stale hint: polling stopped');
      this.showWaiting();
      return;
    }
    this.deps.host.logger.warn('[vault-session] stale wait timed out', { markers: phase.markers.length });
    this.recordAbandoned(phase.markers);
    this.showWaiting();
  }

  private recordAbandoned(markers: readonly ExpectedMarker[]): void {
    const keys = markers.map(abandonedKey);
    try {
      const current = this.deps.replica.local().abandonedWaits;
      const next = appendAbandoned(current, keys);
      if (next.length === current.length && next.every((k, i) => k === current[i])) return;
      this.deps.replica.updateLocal((l) => ({ ...l, abandonedWaits: next }));
    } catch (err) {
      this.deps.host.logger.error('[vault-session] could not record abandoned waits', errorMeta(err));
    }
  }

  private waitingState(): WaitingState | null {
    const phase = this.phase;
    if (phase.kind === 'idle') return null;
    if (phase.kind === 'signed-out') {
      const { entry } = phase;
      const device: WaitingDevice = { deviceId: entry.deviceUuid, deviceName: entry.value.name, savedAtMs: entry.value.last_active_ms };
      return { purpose: 'stale-file', devices: [device], blocking: true, stopOffered: phase.stopOffered, sinceMs: phase.sinceMs };
    }
    return {
      purpose: 'stale-file',
      devices: waitingDevices(phase.markers),
      blocking: phase.mode === 'dialog',
      stopOffered: phase.stopOffered,
      sinceMs: phase.sinceMs,
    };
  }

  private showWaiting(): void {
    setWaitingSafely((w) => this.deps.status.setWaiting(w), this.waitingState(), this.deps.host.logger);
  }

  private startPolling(): void {
    this.poll = this.deps.host.timers.setInterval(() => this.requestRead(), STALE_POLL_MS);
  }

  private requestRead(): void {
    try {
      this.deps.requestRead();
    } catch (err) {
      this.deps.host.logger.error('[vault-session] stale wait read request failed', errorMeta(err));
    }
  }

  private end(why: string): void {
    this.clearTimers();
    this.phase = IDLE;
    this.deps.host.logger.info('[vault-session] stale wait ended', { why });
    this.showWaiting();
  }

  private clearTimers(): void {
    this.poll?.cancel();
    this.stopOffer?.cancel();
    this.poll = null;
    this.stopOffer = null;
  }
}
