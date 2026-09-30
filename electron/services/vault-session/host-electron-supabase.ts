/**
 * supabase-js adapters of the session host (spec 6.2, 9.5): the RPC caller with a hard timeout
 * that never rejects (every failure becomes a classified RpcFailure, so the session layer can
 * treat it as "unconfirmed"), and the own-row Realtime subscription on personal_vault_sessions
 * with a bounded re-subscribe after channel errors. Uses the AuthService client, which already
 * carries the signed-in user's JWT for PostgREST and Realtime.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { SESSION_LOG_PREFIX, type SyncLogger, type TimerHandle, type Timers } from '../sync/host.js';
import type {
  RealtimeHandlers,
  RealtimeHost,
  RealtimeStatus,
  RealtimeSubscription,
  RpcCaller,
  RpcFailure,
  RpcResult,
  SessionRpcName,
} from './host.js';

const P = SESSION_LOG_PREFIX;
export const SESSIONS_TABLE = 'personal_vault_sessions';
/** After a channel error or timeout, subscribe again after this delay. */
export const REALTIME_RETRY_MS = 30_000;
/** SQLSTATE: five digits or upper-case letters (PostgREST's own codes are PGRSTnnn). */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** postgrest-js reports a fetch that never reached the server with status 0. */
const NO_RESPONSE_STATUS = 0;

export interface SupabaseSource {
  getSupabaseClient(): SupabaseClient;
}

interface PostgrestErrorLike {
  readonly message?: string;
  readonly code?: string;
}

function failure(kind: RpcFailure['kind'], status: number | null, code: string | null, message: string): RpcResult {
  return { ok: false, failure: { kind, status, code, message } };
}

/** Maps a postgrest-js error to the session layer's failure kinds (session-client classifies further). */
export function classifyPostgrestError(error: PostgrestErrorLike, status: number | null): RpcResult {
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : null;
  const message = typeof error.message === 'string' ? error.message : 'rpc failed';
  if (status === null || status === NO_RESPONSE_STATUS) return failure('network', null, code, message);
  if (code !== null && SQLSTATE_RE.test(code)) return failure('postgres', status, code, message);
  return failure('http', status, code, message);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createSupabaseRpcCaller(source: SupabaseSource, logger: SyncLogger): RpcCaller {
  return {
    async call(fn: SessionRpcName, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<RpcResult> {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const res = await source.getSupabaseClient().rpc(fn, { ...args }).abortSignal(controller.signal);
        if (timedOut) return failure('timeout', null, null, `${fn} timed out`);
        if (res.error) return classifyPostgrestError(res.error, typeof res.status === 'number' ? res.status : null);
        return { ok: true, data: res.data as unknown };
      } catch (err) {
        if (timedOut) return failure('timeout', null, null, `${fn} timed out`);
        logger.warn(`${P} rpc threw`, { fn, name: errorName(err) });
        return failure('network', null, null, errorName(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function realtimeStatus(status: string): RealtimeStatus {
  if (status === 'SUBSCRIBED') return 'subscribed';
  if (status === 'TIMED_OUT') return 'timed-out';
  if (status === 'CLOSED') return 'closed';
  return 'error';
}

class OwnRowSubscription implements RealtimeSubscription {
  private active = true;
  private channel: RealtimeChannel | null = null;
  private retry: TimerHandle | null = null;
  private attempt = 0;

  constructor(
    private readonly source: SupabaseSource,
    private readonly deviceId: string,
    private readonly handlers: RealtimeHandlers,
    private readonly timers: Timers,
    private readonly logger: SyncLogger,
  ) {
    this.open();
  }

  unsubscribe(): void {
    if (!this.active) return;
    this.active = false;
    this.retry?.cancel();
    this.retry = null;
    this.close();
  }

  private open(): void {
    const client = this.source.getSupabaseClient();
    this.attempt += 1;
    const channel = client
      .channel(`${SESSIONS_TABLE}:${this.deviceId}:${this.attempt}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: SESSIONS_TABLE, filter: `device_id=eq.${this.deviceId}` },
        (payload) => this.onRow(payload.new as Readonly<Record<string, unknown>>),
      );
    this.channel = channel;
    channel.subscribe((status) => this.onStatus(channel, String(status)));
  }

  private onRow(row: Readonly<Record<string, unknown>>): void {
    if (!this.active) return;
    try {
      this.handlers.onUpdate(row);
    } catch (err) {
      this.logger.error(`${P} realtime row handler failed`, { name: errorName(err) });
    }
  }

  private onStatus(channel: RealtimeChannel, raw: string): void {
    if (!this.active || channel !== this.channel) return;
    const status = realtimeStatus(raw);
    this.handlers.onStatus(status);
    if (status === 'error' || status === 'timed-out') this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retry !== null) return;
    this.close();
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      if (this.active) this.open();
    }, REALTIME_RETRY_MS);
  }

  private close(): void {
    const channel = this.channel;
    this.channel = null;
    if (channel === null) return;
    this.source
      .getSupabaseClient()
      .removeChannel(channel)
      .catch((err: unknown) => this.logger.warn(`${P} realtime channel removal failed`, { name: errorName(err) }));
  }
}

export function createSupabaseRealtime(source: SupabaseSource, timers: Timers, logger: SyncLogger): RealtimeHost {
  return {
    subscribeOwnSessionRows(deviceId: string, handlers: RealtimeHandlers): RealtimeSubscription {
      return new OwnRowSubscription(source, deviceId, handlers, timers, logger);
    },
  };
}
