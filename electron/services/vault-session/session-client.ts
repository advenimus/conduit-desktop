/**
 * Typed wrappers of the five session RPCs (spec 6.3 step 5, 6.5, 6.11, 9.4, 9.5; the SQL in
 * supabase/migrations/20260926150905_personal_vault_session_rpcs.sql is the exact contract).
 * Validates every response. Network errors, timeouts, 5xx, SQL errors, check-constraint
 * violations (oversize busy/flags/written_vv), 'not authenticated', 'too_many_sessions' and
 * malformed JSON are all 'unconfirmed': a server problem is never a denial. Only a well-formed
 * `granted: false` with holders is a denial.
 */

import { SESSION_LOG_PREFIX, type SessionRowView } from '../sync/host.js';
import type { AppDot } from '../sync/types.js';
import type { BusyReport, Holder, RpcCaller, RpcFailure, RpcResult, SessionHost, SessionRpcName } from './host.js';
import { markerToJson, parseAcquireData, parseHeartbeatData, parsePeekData, type Parsed } from './session-client-parse.js';

export { markerFromJson, markerToJson, parseHolders, parseSessions } from './session-client-parse.js';

/** Timeout of heartbeat, acquire, release and abandon calls (not in the spec; bounded so quit never hangs). */
export const RPC_TIMEOUT_MS = 10_000;
/** 6.2 early in-use check before the password prompt. */
export const EARLY_CHECK_TIMEOUT_MS = 3_000;
/** Release at quit is bounded separately (the quit flush has its own cap). */
export const QUIT_RELEASE_TIMEOUT_MS = 2_000;

/** personal_vault_sessions.device_name must be 1-120 characters; an empty host name would never get a lease. */
export const FALLBACK_DEVICE_NAME = 'Unknown device';

const SQLSTATE_CHECK_VIOLATION = '23514';
const SQLSTATE_NOT_AUTHENTICATED = '28000';

export type UnconfirmedReason =
  | 'signed-out'
  | 'network'
  | 'timeout'
  | 'server'
  | 'sql'
  | 'constraint'
  | 'auth'
  | 'malformed'
  | 'too-many-sessions';

export interface Unconfirmed {
  readonly kind: 'unconfirmed';
  readonly reason: UnconfirmedReason;
  /** Short diagnostic (SQLSTATE, HTTP status); never user data. */
  readonly detail: string;
}

export interface SessionIds {
  /** sync_state.lineage_id. */
  readonly vaultKey: string;
  /** device_uuid. */
  readonly deviceId: string;
}

export interface AcquireArgs extends SessionIds {
  readonly sessionNonce: string;
  readonly deviceName: string;
  readonly platform: 'macos' | 'windows' | 'linux';
  readonly appVersion: string;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly takeover: boolean;
}

export interface SessionFlags {
  readonly sideFiles: boolean;
}

export interface HeartbeatArgs extends SessionIds {
  readonly leaseId: string;
  readonly active: boolean;
  readonly busy: BusyReport | null;
  /** null keeps the stored flags; { sideFiles: false } sends {}. */
  readonly flags: SessionFlags | null;
  /** null keeps the stored value (coalesce in SQL). */
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  /** Send ONLY a marker not yet acknowledged: re-sending clears an abandon (9.5). */
  readonly marker: AppDot | null;
  readonly pending: boolean | null;
}

export interface ReleaseArgs extends SessionIds {
  readonly leaseId: string;
  /** Same rule as HeartbeatArgs.marker. */
  readonly marker: AppDot | null;
  readonly pending: boolean;
}

export interface AbandonArgs extends SessionIds {
  readonly targetDeviceId: string;
}

export type PeekResult = { readonly kind: 'ok'; readonly limit: number; readonly holders: readonly Holder[] } | Unconfirmed;

export type AcquireResult =
  | {
      readonly kind: 'granted';
      readonly leaseId: string;
      readonly limit: number;
      readonly sessions: readonly SessionRowView[];
      readonly serverNowMs: number | null;
    }
  | {
      readonly kind: 'denied';
      readonly limit: number;
      readonly holders: readonly Holder[];
      readonly sessions: readonly SessionRowView[];
      readonly serverNowMs: number | null;
    }
  | Unconfirmed;

export type HeartbeatResult =
  | { readonly kind: 'ok'; readonly limit: number; readonly sessions: readonly SessionRowView[]; readonly serverNowMs: number | null }
  | { readonly kind: 'displaced'; readonly reason: 'takeover' | 'plan_limit'; readonly byDeviceName: string | null }
  | { readonly kind: 'lost'; readonly reason: 'unknown' | 'superseded' | 'released' | 'expired' }
  | Unconfirmed;

export type SimpleResult = { readonly kind: 'ok' } | Unconfirmed;

/** Maps a transport or SQL failure to an unconfirmed reason (23514 constraint, 28000 auth, other SQLSTATE sql, 5xx server). */
export function classifyFailure(failure: RpcFailure): UnconfirmedReason {
  switch (failure.kind) {
    case 'network':
      return 'network';
    case 'timeout':
      return 'timeout';
    case 'http':
      return 'server';
    case 'postgres':
      if (failure.code === SQLSTATE_CHECK_VIOLATION) return 'constraint';
      if (failure.code === SQLSTATE_NOT_AUTHENTICATED) return 'auth';
      return 'sql';
    default:
      return 'server';
  }
}

function failureDetail(failure: RpcFailure): string {
  return [failure.kind, failure.status === null ? null : String(failure.status), failure.code].filter((p) => p !== null).join(' ');
}

const unconfirmed = (reason: UnconfirmedReason, detail: string): Unconfirmed => ({ kind: 'unconfirmed', reason, detail });

type Answer = { readonly kind: 'answer'; readonly data: unknown } | Unconfirmed;

function acquireParams(a: AcquireArgs): Readonly<Record<string, unknown>> {
  const name = a.deviceName.trim();
  return {
    p_vault_key: a.vaultKey,
    p_device_id: a.deviceId,
    p_session_nonce: a.sessionNonce,
    p_device_name: name.length > 0 ? name : FALLBACK_DEVICE_NAME,
    p_platform: a.platform,
    p_app_version: a.appVersion,
    p_file_name: a.fileName,
    p_file_id: a.fileId,
    p_location: a.location,
    p_takeover: a.takeover,
  };
}

function busyParam(busy: BusyReport | null): Readonly<Record<string, number>> | null {
  if (busy === null) return null;
  const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return { sessions: count(busy.sessions), jobs: count(busy.jobs) };
}

function heartbeatParams(a: HeartbeatArgs): Readonly<Record<string, unknown>> {
  return {
    p_vault_key: a.vaultKey,
    p_device_id: a.deviceId,
    p_lease_id: a.leaseId,
    p_active: a.active,
    p_busy: busyParam(a.busy),
    p_flags: a.flags === null ? null : a.flags.sideFiles ? { side_files: 'present' } : {},
    p_file_name: a.fileName,
    p_file_id: a.fileId,
    p_location: a.location,
    p_written_vv: a.marker === null ? null : markerToJson(a.marker),
    p_pending: a.pending,
  };
}

export interface SessionClientPort {
  peek(ids: SessionIds, timeoutMs?: number): Promise<PeekResult>;
  acquire(args: AcquireArgs): Promise<AcquireResult>;
  heartbeat(args: HeartbeatArgs): Promise<HeartbeatResult>;
  release(args: ReleaseArgs, timeoutMs?: number): Promise<SimpleResult>;
  abandon(args: AbandonArgs): Promise<SimpleResult>;
}

export class SessionClient implements SessionClientPort {
  constructor(
    private readonly rpc: RpcCaller,
    private readonly host: Pick<SessionHost, 'account' | 'logger'>,
  ) {}

  /** Signed out (account.userId() null): { unconfirmed, 'signed-out' } without a call. */
  async peek(ids: SessionIds, timeoutMs: number = EARLY_CHECK_TIMEOUT_MS): Promise<PeekResult> {
    const fn: SessionRpcName = 'vault_session_peek';
    const answer = await this.invoke(fn, { p_vault_key: ids.vaultKey, p_device_id: ids.deviceId }, timeoutMs);
    if (answer.kind === 'unconfirmed') return answer;
    // The SQL selects nothing when auth.uid() is null, so PostgREST answers null.
    if (answer.data === null) return this.reject(fn, unconfirmed('auth', 'peek: no row'));
    const parsed = parsePeekData(answer.data);
    if (!parsed.ok) return this.reject(fn, unconfirmed('malformed', parsed.detail));
    this.logSkipped(fn, parsed.skipped);
    return { kind: 'ok', limit: parsed.value.limit, holders: parsed.value.holders };
  }

  async acquire(args: AcquireArgs): Promise<AcquireResult> {
    const fn: SessionRpcName = 'vault_session_acquire';
    const answer = await this.invoke(fn, acquireParams(args), RPC_TIMEOUT_MS);
    if (answer.kind === 'unconfirmed') return answer;
    const result = this.accept(fn, parseAcquireData(answer.data));
    if (result.kind === 'unconfirmed' && result.reason === 'too-many-sessions') {
      this.host.logger.warn(`${SESSION_LOG_PREFIX} ${fn} refused by the server guard (too many sessions)`);
    }
    return result;
  }

  async heartbeat(args: HeartbeatArgs): Promise<HeartbeatResult> {
    const fn: SessionRpcName = 'vault_session_heartbeat';
    const answer = await this.invoke(fn, heartbeatParams(args), RPC_TIMEOUT_MS);
    if (answer.kind === 'unconfirmed') return answer;
    return this.accept(fn, parseHeartbeatData(answer.data));
  }

  async release(args: ReleaseArgs, timeoutMs: number = RPC_TIMEOUT_MS): Promise<SimpleResult> {
    const params = {
      p_vault_key: args.vaultKey,
      p_device_id: args.deviceId,
      p_lease_id: args.leaseId,
      p_written_vv: args.marker === null ? null : markerToJson(args.marker),
      p_pending: args.pending,
    };
    const answer = await this.invoke('vault_session_release', params, timeoutMs);
    return answer.kind === 'answer' ? { kind: 'ok' } : answer;
  }

  async abandon(args: AbandonArgs): Promise<SimpleResult> {
    const params = { p_vault_key: args.vaultKey, p_device_id: args.deviceId, p_target_device_id: args.targetDeviceId };
    const answer = await this.invoke('vault_session_abandon', params, RPC_TIMEOUT_MS);
    return answer.kind === 'answer' ? { kind: 'ok' } : answer;
  }

  private async invoke(fn: SessionRpcName, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<Answer> {
    if (this.host.account.userId() === null) {
      this.host.logger.debug(`${SESSION_LOG_PREFIX} ${fn} skipped: signed out`);
      return unconfirmed('signed-out', 'no user');
    }
    let result: RpcResult;
    try {
      result = await this.rpc.call(fn, args, timeoutMs);
    } catch (err) {
      // The caller contract says adapters never reject; a throw is an adapter bug, still never a denial.
      this.host.logger.error(`${SESSION_LOG_PREFIX} ${fn} caller threw`, { error: err instanceof Error ? err.name : typeof err });
      return unconfirmed('network', 'caller threw');
    }
    if (result.ok) return { kind: 'answer', data: result.data };
    return this.reject(fn, unconfirmed(classifyFailure(result.failure), failureDetail(result.failure)));
  }

  private reject(fn: SessionRpcName, u: Unconfirmed): Unconfirmed {
    this.host.logger.warn(`${SESSION_LOG_PREFIX} ${fn} unconfirmed`, { reason: u.reason, detail: u.detail });
    return u;
  }

  private accept<T>(fn: SessionRpcName, parsed: Parsed<T>): T | Unconfirmed {
    if (!parsed.ok) return this.reject(fn, unconfirmed('malformed', parsed.detail));
    this.logSkipped(fn, parsed.skipped);
    return parsed.value;
  }

  private logSkipped(fn: SessionRpcName, skipped: number): void {
    if (skipped > 0) this.host.logger.warn(`${SESSION_LOG_PREFIX} ${fn} skipped invalid rows`, { skipped });
  }
}
