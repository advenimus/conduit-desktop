// In-memory emulation of personal_vault_sessions and the five RPCs of spec 9.5 (the SQL in
// supabase/migrations/20260926150905_personal_vault_session_rpcs.sql is the reference): limits
// per user, lease ids, take-over ordering (busy asc, last_active asc), plan_limit on heartbeat
// (busy desc, last_active desc), superseded nonces, never-revive, markers and abandon, the
// 256/1024-byte JSON limits (as 23514 errors), too_many_sessions, 'not authenticated' (28000).
// Realtime UPDATEs are delivered through realtimeFor(). The advisory lock is implicit: every
// call runs to completion before the next (single thread).
import crypto from 'node:crypto';
import type { Clock } from '../../sync/host.js';
import type { RealtimeHandlers, RealtimeHost, RpcCaller, RpcFailure, RpcResult, SessionRpcName } from '../host.js';
import {
  LEASE_TTL_MS,
  SESSIONS_LOOKBACK_MS,
  SqlError,
  TOO_MANY_LIMIT,
  TOO_MANY_WINDOW_MS,
  checkRow,
  holderJson,
  iso,
  jsonArg,
  keepOrder,
  realtimeJson,
  rowKey,
  sameId,
  sessionJson,
  takeoverOrder,
  textArg,
  uuidArg,
  type Json,
  type SessionRow,
} from './fake-session-rows.js';

export interface FakeSessionRow {
  readonly userId: string;
  readonly vaultKey: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly sessionNonce: string;
  readonly status: 'active' | 'released' | 'expired' | 'displaced';
  readonly expiresAtMs: number;
  readonly lastActiveMs: number;
  readonly busy: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly writtenVv: Readonly<Record<string, unknown>>;
  readonly abandonedAtMs: number | null;
}

const DEFAULT_LIMIT = 1;
const POSTGRES_ERROR_STATUS = 400;

interface Subscriber {
  readonly userId: string;
  readonly deviceId: string;
  readonly handlers: RealtimeHandlers;
  active: boolean;
}

type Args = Readonly<Record<string, unknown>>;

export class FakeSessionServer {
  private readonly table = new Map<string, SessionRow>();
  private readonly limits = new Map<string, number>();
  private readonly failures: RpcFailure[] = [];
  private readonly subscribers: Subscriber[] = [];

  constructor(private readonly clock: Clock) {}

  /** vault_device_limit for a user (-1 unlimited). Default 1. */
  setLimit(userId: string, limit: number): void {
    this.limits.set(userId, limit);
  }

  /** An RpcCaller authenticated as `userId` (null = not authenticated). */
  clientFor(userId: string | null): RpcCaller {
    return { call: (fn, args) => Promise.resolve().then(() => this.dispatch(userId, fn, args)) };
  }

  /** Realtime delivering UPDATEs of `userId`'s rows (RLS). */
  realtimeFor(userId: string): RealtimeHost {
    return {
      subscribeOwnSessionRows: (deviceId, handlers) => {
        const sub: Subscriber = { userId, deviceId: deviceId.toLowerCase(), handlers, active: true };
        this.subscribers.push(sub);
        queueMicrotask(() => sub.active && handlers.onStatus('subscribed'));
        return {
          unsubscribe: () => {
            sub.active = false;
            this.subscribers.splice(this.subscribers.indexOf(sub), 1);
          },
        };
      },
    };
  }

  /** The next `count` calls of any client fail with `failure` (network drop, 5xx, SQL error). */
  failNext(failure: RpcFailure, count = 1): void {
    for (let i = 0; i < count; i++) this.failures.push(failure);
  }

  rows(): readonly FakeSessionRow[] {
    return [...this.table.values()].map((r) => ({
      userId: r.userId,
      vaultKey: r.vaultKey,
      deviceId: r.deviceId,
      leaseId: r.leaseId,
      sessionNonce: r.sessionNonce,
      status: r.status,
      expiresAtMs: r.expiresAtMs,
      lastActiveMs: r.lastActiveMs,
      busy: r.busy,
      flags: r.flags,
      writtenVv: r.writtenVv,
      abandonedAtMs: r.abandonedAtMs,
    }));
  }

  /** Subscribers still listening (tests assert unsubscribe). */
  subscriberCount(): number {
    return this.subscribers.length;
  }

  // ---------- dispatch ----------

  private dispatch(userId: string | null, fn: SessionRpcName, args: Args): RpcResult {
    const failure = this.failures.shift();
    if (failure !== undefined) return { ok: false, failure };
    try {
      return { ok: true, data: this.run(userId, fn, args) };
    } catch (err) {
      if (!(err instanceof SqlError)) throw err;
      return { ok: false, failure: { kind: 'postgres', status: POSTGRES_ERROR_STATUS, code: err.code, message: err.message } };
    }
  }

  private run(userId: string | null, fn: SessionRpcName, args: Args): unknown {
    if (fn === 'vault_session_peek') return userId === null ? null : this.peek(userId, args);
    if (userId === null) throw new SqlError('28000', 'not authenticated');
    switch (fn) {
      case 'vault_session_acquire':
        return this.acquire(userId, args);
      case 'vault_session_heartbeat':
        return this.heartbeat(userId, args);
      case 'vault_session_release':
        return this.release(userId, args);
      case 'vault_session_abandon':
        return this.abandon(userId, args);
    }
  }

  private now(): number {
    return this.clock.now();
  }

  private limitOf(userId: string): number {
    return this.limits.get(userId) ?? DEFAULT_LIMIT;
  }

  private vaultRows(userId: string, vaultKey: string): SessionRow[] {
    return [...this.table.values()].filter((r) => r.userId === userId && sameId(r.vaultKey, vaultKey));
  }

  private get(userId: string, vaultKey: string, deviceId: string): SessionRow | undefined {
    return this.table.get(rowKey(userId, vaultKey, deviceId));
  }

  /** UPDATE of one existing row: constraints, then the Realtime delivery. */
  private update(row: SessionRow, patch: Partial<SessionRow>): SessionRow {
    const next: SessionRow = { ...row, ...patch };
    checkRow(next);
    this.table.set(rowKey(row.userId, row.vaultKey, row.deviceId), next);
    this.deliver(next);
    return next;
  }

  private deliver(row: SessionRow): void {
    const payload = realtimeJson(row);
    for (const sub of [...this.subscribers]) {
      if (sub.userId !== row.userId || !sameId(sub.deviceId, row.deviceId)) continue;
      queueMicrotask(() => sub.active && sub.handlers.onUpdate(payload));
    }
  }

  private holders(userId: string, vaultKey: string, deviceId: string): Json[] {
    const now = this.now();
    return this.vaultRows(userId, vaultKey)
      .filter((r) => r.status === 'active' && r.expiresAtMs >= now && !sameId(r.deviceId, deviceId))
      .sort((a, b) => b.lastActiveMs - a.lastActiveMs)
      .map(holderJson);
  }

  private sessionsFor(userId: string, vaultKey: string, deviceId: string): Json[] {
    const now = this.now();
    return this.vaultRows(userId, vaultKey)
      .filter((r) => !sameId(r.deviceId, deviceId) && r.heartbeatAtMs > now - SESSIONS_LOOKBACK_MS)
      .sort((a, b) => b.lastActiveMs - a.lastActiveMs)
      .map((r) => sessionJson(r, now));
  }

  // ---------- RPCs ----------

  private peek(userId: string, args: Args): unknown {
    const vaultKey = uuidArg(args.p_vault_key, 'p_vault_key') ?? '';
    const deviceId = uuidArg(args.p_device_id, 'p_device_id') ?? '';
    return { limit: this.limitOf(userId), holders: this.holders(userId, vaultKey, deviceId) };
  }

  private acquire(userId: string, args: Args): unknown {
    const vaultKey = uuidArg(args.p_vault_key, 'p_vault_key');
    const deviceId = uuidArg(args.p_device_id, 'p_device_id');
    const nonce = uuidArg(args.p_session_nonce, 'p_session_nonce');
    if (vaultKey === null || deviceId === null || nonce === null) throw new SqlError('22023', 'missing id');
    const now = this.now();
    const recent = [...this.table.values()].filter((r) => r.userId === userId && r.heartbeatAtMs > now - TOO_MANY_WINDOW_MS);
    if (recent.length > TOO_MANY_LIMIT) return { granted: false, error: 'too_many_sessions' };
    const limit = this.limitOf(userId);
    for (const r of this.vaultRows(userId, vaultKey)) {
      if (r.status === 'active' && r.expiresAtMs < now) this.update(r, { status: 'expired' });
    }
    if (limit !== -1) {
      const others = this.vaultRows(userId, vaultKey).filter((r) => r.status === 'active' && !sameId(r.deviceId, deviceId));
      if (others.length >= limit) {
        if (args.p_takeover !== true) return this.denied(userId, vaultKey, deviceId, limit);
        const victims = [...others].sort(takeoverOrder).slice(0, others.length - limit + 1);
        for (const v of victims) this.update(v, { status: 'displaced', displacedByDevice: deviceId, displacedReason: 'takeover', displacedAtMs: now });
      }
    }
    const leaseId = crypto.randomUUID();
    this.upsert(userId, vaultKey, deviceId, { leaseId, sessionNonce: nonce }, args);
    return {
      granted: true,
      lease_id: leaseId,
      limit,
      ttl_seconds: LEASE_TTL_MS / 1000,
      heartbeat_seconds: 30,
      sessions: this.sessionsFor(userId, vaultKey, deviceId),
      server_now: iso(now),
    };
  }

  private denied(userId: string, vaultKey: string, deviceId: string, limit: number): unknown {
    return {
      granted: false,
      limit,
      holders: this.holders(userId, vaultKey, deviceId),
      sessions: this.sessionsFor(userId, vaultKey, deviceId),
      server_now: iso(this.now()),
    };
  }

  /** INSERT ... ON CONFLICT DO UPDATE of acquire (busy, flags, abandon and displacement reset). */
  private upsert(userId: string, vaultKey: string, deviceId: string, ids: { leaseId: string; sessionNonce: string }, args: Args): void {
    const now = this.now();
    const fields = {
      ...ids,
      deviceName: textArg(args.p_device_name, 120) ?? '',
      platform: textArg(args.p_platform) ?? '',
      appVersion: textArg(args.p_app_version, 40),
      fileName: textArg(args.p_file_name, 255),
      fileId: uuidArg(args.p_file_id, 'p_file_id'),
      location: textArg(args.p_location, 120),
      status: 'active' as const,
      acquiredAtMs: now,
      heartbeatAtMs: now,
      expiresAtMs: now + LEASE_TTL_MS,
      lastActiveMs: now,
      busy: {},
      flags: {},
      abandonedAtMs: null,
      displacedByDevice: null,
      displacedReason: null,
      displacedAtMs: null,
    };
    const existing = this.get(userId, vaultKey, deviceId);
    if (existing !== undefined) {
      this.update(existing, fields);
      return;
    }
    const row: SessionRow = { userId, vaultKey, deviceId, writtenVv: {}, writtenAtMs: null, pendingChanges: false, ...fields };
    checkRow(row);
    this.table.set(rowKey(userId, vaultKey, deviceId), row);
  }

  private heartbeat(userId: string, args: Args): unknown {
    const vaultKey = uuidArg(args.p_vault_key, 'p_vault_key') ?? '';
    const deviceId = uuidArg(args.p_device_id, 'p_device_id') ?? '';
    const leaseId = uuidArg(args.p_lease_id, 'p_lease_id');
    const before = this.get(userId, vaultKey, deviceId);
    if (before === undefined) return { status: 'lost', reason: 'unknown' };
    if (!sameId(before.leaseId, leaseId)) return { status: 'lost', reason: 'superseded' };
    const recorded = this.update(before, this.reportPatch(args, before));
    if (before.status === 'displaced') return this.displacedAnswer(userId, vaultKey, before.displacedReason, before.displacedByDevice);
    const now = this.now();
    if (before.status !== 'active' || before.expiresAtMs < now) {
      if (recorded.status === 'active') this.update(recorded, { status: 'expired' });
      return { status: 'lost', reason: before.status === 'released' ? 'released' : 'expired' };
    }
    const beat = this.update(recorded, {
      heartbeatAtMs: now,
      expiresAtMs: now + LEASE_TTL_MS,
      lastActiveMs: args.p_active === true ? now : recorded.lastActiveMs,
    });
    const limit = this.limitOf(userId);
    if (limit !== -1) {
      this.applyPlanLimit(userId, vaultKey, limit);
      const after = this.get(userId, vaultKey, deviceId) ?? beat;
      if (after.status === 'displaced') return this.displacedAnswer(userId, vaultKey, 'plan_limit', after.displacedByDevice);
    }
    return { status: 'ok', limit, sessions: this.sessionsFor(userId, vaultKey, deviceId), server_now: iso(now) };
  }

  /** "Record what this lease published, whatever its status" (coalesce semantics). */
  private reportPatch(args: Args, row: SessionRow): Partial<SessionRow> {
    const vv = jsonArg(args.p_written_vv);
    const now = this.now();
    return {
      writtenVv: vv ?? row.writtenVv,
      writtenAtMs: vv === null ? row.writtenAtMs : now,
      abandonedAtMs: vv === null ? row.abandonedAtMs : null,
      pendingChanges: typeof args.p_pending === 'boolean' ? args.p_pending : row.pendingChanges,
      fileName: textArg(args.p_file_name, 255) ?? row.fileName,
      fileId: uuidArg(args.p_file_id, 'p_file_id') ?? row.fileId,
      location: textArg(args.p_location, 120) ?? row.location,
      busy: jsonArg(args.p_busy) ?? row.busy,
      flags: jsonArg(args.p_flags) ?? row.flags,
    };
  }

  private displacedAnswer(userId: string, vaultKey: string, reason: 'takeover' | 'plan_limit' | null, by: string | null): unknown {
    const byRow = by === null ? undefined : this.get(userId, vaultKey, by);
    return { status: 'displaced', reason, by: byRow?.deviceName ?? null };
  }

  /** 6.9 downgrade: keep the busy device, then the most recently active; the rest are displaced. */
  private applyPlanLimit(userId: string, vaultKey: string, limit: number): void {
    const now = this.now();
    const ranked = this.vaultRows(userId, vaultKey)
      .filter((r) => r.status === 'active' && r.expiresAtMs >= now)
      .sort(keepOrder);
    const keeper = ranked[0]?.deviceId ?? null;
    for (const r of ranked.slice(limit)) {
      this.update(r, { status: 'displaced', displacedReason: 'plan_limit', displacedAtMs: now, displacedByDevice: keeper });
    }
  }

  private release(userId: string, args: Args): null {
    const vaultKey = uuidArg(args.p_vault_key, 'p_vault_key') ?? '';
    const deviceId = uuidArg(args.p_device_id, 'p_device_id') ?? '';
    const leaseId = uuidArg(args.p_lease_id, 'p_lease_id');
    const row = this.get(userId, vaultKey, deviceId);
    if (row === undefined || !sameId(row.leaseId, leaseId)) return null;
    const vv = jsonArg(args.p_written_vv);
    const now = this.now();
    this.update(row, {
      status: row.status === 'active' ? 'released' : row.status,
      expiresAtMs: Math.min(row.expiresAtMs, now),
      heartbeatAtMs: now,
      writtenVv: vv ?? row.writtenVv,
      writtenAtMs: vv === null ? row.writtenAtMs : now,
      abandonedAtMs: vv === null ? row.abandonedAtMs : null,
      pendingChanges: typeof args.p_pending === 'boolean' ? args.p_pending : false,
    });
    return null;
  }

  private abandon(userId: string, args: Args): null {
    const vaultKey = uuidArg(args.p_vault_key, 'p_vault_key') ?? '';
    const deviceId = uuidArg(args.p_device_id, 'p_device_id');
    const target = uuidArg(args.p_target_device_id, 'p_target_device_id');
    if (target === null || sameId(target, deviceId)) return null;
    const row = this.get(userId, vaultKey, target);
    if (row !== undefined) this.update(row, { abandonedAtMs: this.now() });
    return null;
  }
}
