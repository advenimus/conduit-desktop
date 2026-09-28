/**
 * Inputs of the lease loop (spec 6.2): p_active, the per-beat arguments read defensively from
 * the host and the runtime's context, the next action derived from the lease state, and which
 * heartbeat answers acknowledge a publish marker (9.5). Part of heartbeat.ts.
 */

import { SESSION_LOG_PREFIX, type SyncLogger } from '../sync/host.js';
import type { AppDot } from '../sync/types.js';
import type { LeaseState } from './lease.js';
import type { HeartbeatArgs, HeartbeatResult, SessionIds } from './session-client.js';
import type { BusyReport, SessionHost } from './host.js';
import type { HeartbeatContext } from './heartbeat.js';

/** 6.2 p_active: idle < 60 s or focused in the last 60 s. */
export const ACTIVE_WINDOW_MS = 60_000;

const MS_PER_SECOND = 1000;
const P = SESSION_LOG_PREFIX;

/** 6.2 p_active. */
export function isActive(nowMs: number, idleSeconds: number, focused: boolean, lastFocusMs: number | null): boolean {
  if (focused) return true;
  if (Number.isFinite(idleSeconds) && idleSeconds >= 0 && idleSeconds * MS_PER_SECOND < ACTIVE_WINDOW_MS) return true;
  return lastFocusMs !== null && Number.isFinite(lastFocusMs) && nowMs - lastFocusMs <= ACTIVE_WINDOW_MS;
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export type HeartbeatAction = { readonly kind: 'beat'; readonly leaseId: string } | { readonly kind: 'acquire' } | { readonly kind: 'idle' };

/** What the loop does next is read from the lease, so a lease changed elsewhere (take-over answer) steers it too. */
export function actionFor(state: LeaseState): HeartbeatAction {
  switch (state.kind) {
    case 'confirmed':
      return { kind: 'beat', leaseId: state.leaseId };
    case 'unconfirmed':
      return state.leaseId === null ? { kind: 'acquire' } : { kind: 'beat', leaseId: state.leaseId };
    case 'lost':
      return { kind: 'acquire' };
    default:
      return { kind: 'idle' };
  }
}

/** The server ran the heartbeat's UPDATE (9.5): only then is the marker on the row. */
export function acknowledgesMarker(result: HeartbeatResult): boolean {
  if (result.kind === 'ok' || result.kind === 'displaced') return true;
  return result.kind === 'lost' && (result.reason === 'released' || result.reason === 'expired');
}

/** The runtime's context, or null (stored values kept server-side) when it cannot be read. */
export function readContext(context: () => HeartbeatContext, logger: SyncLogger): HeartbeatContext | null {
  try {
    return context();
  } catch (err) {
    logger.error(`${P} heartbeat context unavailable`, { error: errorName(err) });
    return null;
  }
}

function readActive(host: Pick<SessionHost, 'clock' | 'logger' | 'power' | 'activity'>): boolean {
  const { power, activity } = host;
  try {
    return isActive(host.clock.now(), power.systemIdleSeconds(), activity.isFocused(), activity.lastFocusMs());
  } catch (err) {
    host.logger.error(`${P} activity check failed`, { error: errorName(err) });
    return false;
  }
}

function readBusy(host: Pick<SessionHost, 'logger' | 'busy'>): BusyReport | null {
  try {
    return host.busy.busy();
  } catch (err) {
    host.logger.error(`${P} busy report failed`, { error: errorName(err) });
    return null;
  }
}

export interface BeatInputs {
  readonly ids: SessionIds;
  readonly leaseId: string;
  readonly marker: AppDot | null;
  readonly host: Pick<SessionHost, 'clock' | 'logger' | 'power' | 'activity' | 'busy'>;
  readonly context: () => HeartbeatContext;
}

export function heartbeatArgs(input: BeatInputs): HeartbeatArgs {
  const ctx = readContext(input.context, input.host.logger);
  return {
    vaultKey: input.ids.vaultKey,
    deviceId: input.ids.deviceId,
    leaseId: input.leaseId,
    active: readActive(input.host),
    busy: readBusy(input.host),
    flags: ctx === null ? null : { sideFiles: ctx.sideFilesPresent },
    fileName: ctx?.fileName ?? null,
    fileId: ctx?.fileId ?? null,
    location: ctx?.location ?? null,
    marker: input.marker,
    pending: ctx === null ? null : ctx.pendingChanges,
  };
}
