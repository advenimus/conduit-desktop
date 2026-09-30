/**
 * Own-row Realtime subscription (spec 6.2 displacement signal, 6.5, 9.5 notes): UPDATEs of
 * personal_vault_sessions filtered by device_id; rows of other vaults are ignored; a row whose
 * lease_id differs from ours means another running copy with this device identity acquired
 * (superseded); status 'displaced' with our lease id means take-over, plan limit or device cap.
 * A not-owner or update-required row carries no detail for the notice, so it asks for a
 * heartbeat at once (which answers with the detail). Realtime is only a fast path: the next
 * heartbeat (at most 30 s) is the fallback.
 */

import type { LeaseTracker } from './lease.js';
import { SESSION_LOG_PREFIX, type SessionRowView } from '../sync/host.js';
import type { DisplacementReason, RealtimeHost, RealtimeStatus, RealtimeSubscription, SessionHost } from './host.js';

const P = SESSION_LOG_PREFIX;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RealtimeVerdict =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'displaced'; readonly reason: 'takeover' | 'plan_limit' | 'device_cap'; readonly byDeviceId: string | null }
  | { readonly kind: 'refused'; readonly reason: 'not_owner' | 'update_required' };

const IGNORE: RealtimeVerdict = { kind: 'ignore' };
const SUPERSEDED: RealtimeVerdict = { kind: 'superseded' };

function sameId(value: unknown, id: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === id.toLowerCase();
}

/**
 * Pure: classify one UPDATE row against our vault key and lease id. `sessionNonce` (optional)
 * guards a race: our own acquire's row can arrive over Realtime before the RPC answer updated
 * the lease tracker; a row carrying this launch's nonce is never "another running copy".
 */
export function classifyRealtimeRow(
  row: Readonly<Record<string, unknown>>,
  vaultKey: string,
  leaseId: string | null,
  sessionNonce: string | null = null,
): RealtimeVerdict {
  if (!sameId(row.vault_key, vaultKey)) return IGNORE;
  if (leaseId === null || typeof row.lease_id !== 'string') return IGNORE;
  if (!sameId(row.lease_id, leaseId)) {
    if (sessionNonce !== null && sameId(row.session_nonce, sessionNonce)) return IGNORE;
    return SUPERSEDED;
  }
  if (row.status !== 'displaced') return IGNORE;
  const reason = row.displaced_reason;
  if (reason === 'not_owner' || reason === 'update_required') return { kind: 'refused', reason };
  if (reason !== 'takeover' && reason !== 'plan_limit' && reason !== 'device_cap') return IGNORE;
  const by = row.displaced_by_device;
  return { kind: 'displaced', reason, byDeviceId: typeof by === 'string' && UUID_RE.test(by) ? by.toLowerCase() : null };
}

export interface SessionRealtimeDeps {
  readonly realtime: RealtimeHost;
  readonly vaultKey: string;
  readonly deviceId: string;
  readonly lease: LeaseTracker;
  readonly host: Pick<SessionHost, 'logger'>;
  /** Maps displaced_by_device to a name through the last sessions list (null when unknown). */
  readonly deviceName: (deviceId: string, sessions: readonly SessionRowView[]) => string | null;
  /**
   * Asks the server for a device the sessions list does not have yet (a device that just took
   * the vault over for the first time); null when it cannot tell.
   */
  readonly lookupName?: (deviceId: string) => Promise<string | null>;
  readonly onDisplaced: (reason: DisplacementReason, byDeviceName: string | null) => void;
  /** A heartbeat now, for rows whose notice needs the heartbeat's detail; absent: displace without it. */
  readonly beatNow?: () => void;
  /** This launch's session nonce (SessionConfig.sessionNonce); see classifyRealtimeRow. */
  readonly sessionNonce?: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export class SessionRealtime {
  private active = false;
  /** One displacement per subscription: later rows of the same event add nothing. */
  private fired = false;
  private sub: RealtimeSubscription | null = null;

  constructor(private readonly deps: SessionRealtimeDeps) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.fired = false;
    try {
      this.sub = this.deps.realtime.subscribeOwnSessionRows(this.deps.deviceId, {
        onUpdate: (row) => this.onUpdate(row),
        onStatus: (status) => this.onStatus(status),
      });
    } catch (err) {
      this.sub = null;
      this.deps.host.logger.error(`${P} realtime subscribe failed; the heartbeat remains the displacement signal`, {
        error: errorName(err),
      });
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const sub = this.sub;
    this.sub = null;
    if (sub === null) return;
    try {
      sub.unsubscribe();
    } catch (err) {
      this.deps.host.logger.error(`${P} realtime unsubscribe failed`, { error: errorName(err) });
    }
  }

  private onUpdate(row: Readonly<Record<string, unknown>>): void {
    if (!this.active || this.fired) return;
    try {
      this.handle(row);
    } catch (err) {
      this.deps.host.logger.error(`${P} realtime update handling failed`, { error: errorName(err) });
    }
  }

  private handle(row: Readonly<Record<string, unknown>>): void {
    const { lease, host } = this.deps;
    const verdict = classifyRealtimeRow(row, this.deps.vaultKey, lease.leaseId(), this.deps.sessionNonce ?? null);
    if (verdict.kind === 'ignore') return;
    this.fired = true;
    if (verdict.kind === 'superseded') {
      host.logger.warn(`${P} realtime: lease superseded by another running copy with this device identity`);
      lease.onSuperseded();
      this.deps.onDisplaced('superseded', null);
      return;
    }
    if (verdict.kind === 'refused') {
      host.logger.info(`${P} realtime: lease refused by the server`, { reason: verdict.reason });
      if (this.deps.beatNow !== undefined) this.deps.beatNow();
      else this.deps.onDisplaced(verdict.reason, null);
      return;
    }
    const byId = verdict.byDeviceId;
    const name = byId === null ? null : this.deps.deviceName(byId, lease.sessions());
    host.logger.info(`${P} realtime: lease displaced`, { reason: verdict.reason, named: name !== null });
    const lookup = this.deps.lookupName;
    if (name !== null || byId === null || lookup === undefined) {
      this.deps.onDisplaced(verdict.reason, name);
      return;
    }
    void this.lookUp(lookup, byId).then((found) => {
      if (this.active) this.deps.onDisplaced(verdict.reason, found);
    });
  }

  private async lookUp(lookup: (deviceId: string) => Promise<string | null>, deviceId: string): Promise<string | null> {
    try {
      return await lookup(deviceId);
    } catch (err) {
      this.deps.host.logger.warn(`${P} realtime: looking up the other device's name failed`, { error: errorName(err) });
      return null;
    }
  }

  private onStatus(status: RealtimeStatus): void {
    if (!this.active) return;
    if (status === 'subscribed') this.deps.host.logger.info(`${P} realtime ${status}`);
    else this.deps.host.logger.warn(`${P} realtime ${status}`);
  }
}
