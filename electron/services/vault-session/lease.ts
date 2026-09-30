/**
 * Lease bookkeeping of one open vault (spec 6.3 step 5, 6.8, 6.11 markers, 9.5): lease id,
 * confirmed versus unconfirmed (confirmed = last acquire or heartbeat OK within 90 s), the
 * server limit and sessions list from the last good answer, displacement and loss, and the
 * publish-marker delivery rule (a marker is sent until acknowledged, then never again, so an
 * abandon is not undone). Pure state over injected times.
 */

import { compareHlc } from '../sync/sibling.js';
import type { SessionRowView } from '../sync/host.js';
import type { AppDot } from '../sync/types.js';
import type { AcquireResult, HeartbeatResult, UnconfirmedReason } from './session-client.js';
import type { DisplacementReason } from './host.js';

/** 6.2 lease time limit (server time); also the "confirmed" window (6.8). */
export const LEASE_TTL_MS = 90_000;

export type LeaseState =
  /** Signed out: no server lease; owner claims decide (6.7). */
  | { readonly kind: 'none' }
  | { readonly kind: 'confirmed'; readonly leaseId: string; readonly lastOkMs: number }
  /** No answer from the server; `leaseId` kept when an earlier acquire succeeded. */
  | { readonly kind: 'unconfirmed'; readonly leaseId: string | null; readonly sinceMs: number; readonly reason: UnconfirmedReason }
  /**
   * `leaseId`: the id our row still carries after a take-over or plan limit, so the release can
   * record the final save's marker and pending flag on it (9.5 matches on lease_id); null when
   * superseded (the row already holds another lease id).
   */
  | { readonly kind: 'displaced'; readonly reason: DisplacementReason; readonly byDeviceName: string | null; readonly leaseId: string | null }
  /** Released by us (lock, quit) or found released/expired: a new acquire is needed. */
  | { readonly kind: 'lost'; readonly reason: 'unknown' | 'released' | 'expired' };

const NONE: LeaseState = Object.freeze({ kind: 'none' });
const NO_SESSIONS: readonly SessionRowView[] = Object.freeze([]);

function sameDot(a: AppDot, b: AppDot): boolean {
  return a.dev === b.dev && a.ms === b.ms && a.c === b.c;
}

export class LeaseTracker {
  private current: LeaseState = NONE;
  private limit: number | null = null;
  private rows: readonly SessionRowView[] = NO_SESSIONS;
  private pendingMarker: AppDot | null = null;
  /** server_now minus our clock at the last good answer that carried it. */
  private serverOffsetMs = 0;

  state(): LeaseState {
    return this.current;
  }

  leaseId(): string | null {
    const s = this.current;
    return s.kind === 'confirmed' || s.kind === 'unconfirmed' ? s.leaseId : null;
  }

  /** The lease id vault_session_release must carry: also after a displacement that kept our row's id. */
  releaseLeaseId(): string | null {
    const s = this.current;
    return s.kind === 'displaced' ? s.leaseId : this.leaseId();
  }

  /** 6.8: confirmed and lastOkMs within LEASE_TTL_MS of nowMs. */
  isConfirmed(nowMs: number): boolean {
    const s = this.current;
    return s.kind === 'confirmed' && nowMs - s.lastOkMs <= LEASE_TTL_MS;
  }

  /** Limit from the last good acquire/heartbeat, else null. */
  serverLimit(): number | null {
    return this.limit;
  }

  /** Sessions from the last good acquire/heartbeat. */
  sessions(): readonly SessionRowView[] {
    return this.rows;
  }

  /** A time of this device's clock on the server's clock (session rows carry server times). */
  toServerMs(localMs: number): number {
    return localMs + this.serverOffsetMs;
  }

  onAcquire(result: AcquireResult, nowMs: number): void {
    if (result.kind === 'granted') {
      this.current = Object.freeze({ kind: 'confirmed', leaseId: result.leaseId, lastOkMs: nowMs });
      this.remember(result.limit, result.sessions, result.serverNowMs, nowMs);
    } else if (result.kind === 'unconfirmed') {
      this.current = this.unconfirmed(result.reason, nowMs);
    }
    // A denial leaves an existing lease alone: the runtime decides (6.8 reconnect conflict).
  }

  onHeartbeat(result: HeartbeatResult, nowMs: number): void {
    switch (result.kind) {
      case 'ok': {
        const id = this.leaseId();
        if (id === null) return;
        this.current = Object.freeze({ kind: 'confirmed', leaseId: id, lastOkMs: nowMs });
        this.remember(result.limit, result.sessions, result.serverNowMs, nowMs);
        return;
      }
      case 'displaced':
        this.current = Object.freeze({ kind: 'displaced', reason: result.reason, byDeviceName: result.byDeviceName, leaseId: this.releaseLeaseId() });
        return;
      case 'lost':
        this.current =
          result.reason === 'superseded'
            ? Object.freeze({ kind: 'displaced', reason: 'superseded', byDeviceName: null, leaseId: null })
            : Object.freeze({ kind: 'lost', reason: result.reason });
        return;
      case 'unconfirmed':
        this.current = this.unconfirmed(result.reason, nowMs);
        return;
    }
  }

  /** Realtime saw our row with another lease_id. */
  onSuperseded(): void {
    this.current = Object.freeze({ kind: 'displaced', reason: 'superseded', byDeviceName: null, leaseId: null });
  }

  onReleased(): void {
    this.current = Object.freeze({ kind: 'lost', reason: 'released' });
  }

  signedOut(): void {
    this.current = NONE;
    this.limit = null;
    this.rows = NO_SESSIONS;
  }

  /** The engine published `marker` (SessionSignals.published). A newer marker replaces an older one. */
  markerPublished(marker: AppDot): void {
    const pending = this.pendingMarker;
    if (pending !== null && pending.dev === marker.dev && compareHlc(pending, marker) > 0) return;
    this.pendingMarker = Object.freeze({ dev: marker.dev, ms: marker.ms, c: marker.c });
  }

  /** The marker to send with the next heartbeat or release, or null when already acknowledged. */
  markerToSend(): AppDot | null {
    return this.pendingMarker;
  }

  /** A heartbeat or release carrying `marker` got any server answer that ran the UPDATE (ok, displaced, lost/released|expired). */
  markerAcknowledged(marker: AppDot): void {
    if (this.pendingMarker !== null && sameDot(this.pendingMarker, marker)) this.pendingMarker = null;
  }

  private unconfirmed(reason: UnconfirmedReason, nowMs: number): LeaseState {
    const prev = this.current;
    const sinceMs = prev.kind === 'unconfirmed' ? prev.sinceMs : nowMs;
    return Object.freeze({ kind: 'unconfirmed', leaseId: this.leaseId(), sinceMs, reason });
  }

  private remember(limit: number, sessions: readonly SessionRowView[], serverNowMs: number | null, nowMs: number): void {
    this.limit = limit;
    this.rows = Object.freeze([...sessions]);
    if (serverNowMs !== null) this.serverOffsetMs = serverNowMs - nowMs;
  }
}
