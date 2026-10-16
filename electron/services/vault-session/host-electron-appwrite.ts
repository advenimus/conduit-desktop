/**
 * Appwrite adapters of the session host (spec 6.2, 9.5): the RPC caller with a hard timeout that
 * never rejects (every failure becomes a classified RpcFailure, so the session layer can treat it
 * as "unconfirmed"), and the own-row Realtime subscription on personal_vault_sessions. Both run as
 * the signed-in user through the AuthService session.
 */

import type { ConduitDb } from '../backend/conduit-db.js';
import { type RealtimeOptions, type Subscription, watchRows } from '../backend/realtime.js';
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
/** After a failed subscribe, try again after this delay. */
export const REALTIME_RETRY_MS = 30_000;
/** SQLSTATE: five digits or upper-case letters (PostgREST's own codes are PGRSTnnn). */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** The client reports a call that never reached the server with status 0. */
const NO_RESPONSE_STATUS = 0;

export interface BackendSource {
  getDb(): ConduitDb;
  getRealtimeOptions(): RealtimeOptions | null;
}

interface ApiErrorLike {
  readonly message?: string;
  readonly code?: string;
}

function failure(kind: RpcFailure['kind'], status: number | null, code: string | null, message: string): RpcResult {
  return { ok: false, failure: { kind, status, code, message } };
}

/** Maps an api error to the session layer's failure kinds (session-client classifies further). */
export function classifyApiError(error: ApiErrorLike, status: number | null): RpcResult {
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : null;
  const message = typeof error.message === 'string' ? error.message : 'rpc failed';
  if (status === null || status === NO_RESPONSE_STATUS) return failure('network', null, code, message);
  if (code !== null && SQLSTATE_RE.test(code)) return failure('postgres', status, code, message);
  return failure('http', status, code, message);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createAppwriteRpcCaller(source: BackendSource, logger: SyncLogger): RpcCaller {
  return {
    async call(fn: SessionRpcName, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<RpcResult> {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const res = await source.getDb().rpc(fn, { ...args }).abortSignal(controller.signal);
        if (timedOut) return failure('timeout', null, null, `${fn} timed out`);
        if (res.error) return classifyApiError(res.error, res.status);
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

const STATUS: Record<'open' | 'closed' | 'error', RealtimeStatus> = { open: 'subscribed', closed: 'closed', error: 'error' };

class OwnRowSubscription implements RealtimeSubscription {
  private active = true;
  private sub: Subscription | null = null;
  private retry: TimerHandle | null = null;
  private attempt = 0;

  constructor(
    private readonly source: BackendSource,
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
    const options = this.source.getRealtimeOptions();
    const attempt = ++this.attempt;
    if (!options) {
      this.handlers.onStatus('error');
      this.scheduleRetry();
      return;
    }
    watchRows(
      options,
      [SESSIONS_TABLE],
      { column: 'device_id', value: this.deviceId },
      (change) => {
        if (change.kind === 'UPDATE') this.onRow(change.row);
      },
      (status) => {
        if (this.active && attempt === this.attempt) this.handlers.onStatus(STATUS[status]);
      },
    ).then(
      (sub) => {
        if (!this.active || attempt !== this.attempt) {
          sub.close().catch(() => undefined);
          return;
        }
        this.sub = sub;
      },
      (err) => {
        if (!this.active || attempt !== this.attempt) return;
        this.logger.warn(`${P} realtime subscribe failed`, { name: errorName(err) });
        this.handlers.onStatus('error');
        this.scheduleRetry();
      },
    );
  }

  private onRow(row: Readonly<Record<string, unknown>>): void {
    if (!this.active) return;
    try {
      this.handlers.onUpdate(row);
    } catch (err) {
      this.logger.error(`${P} realtime row handler failed`, { name: errorName(err) });
    }
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
    const sub = this.sub;
    this.sub = null;
    sub?.close().catch((err: unknown) => this.logger.warn(`${P} realtime close failed`, { name: errorName(err) }));
  }
}

export function createAppwriteRealtime(source: BackendSource, timers: Timers, logger: SyncLogger): RealtimeHost {
  return {
    subscribeOwnSessionRows(deviceId: string, handlers: RealtimeHandlers): RealtimeSubscription {
      return new OwnRowSubscription(source, deviceId, handlers, timers, logger);
    },
  };
}
