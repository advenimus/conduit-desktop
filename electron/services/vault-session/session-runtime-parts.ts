/**
 * Small pieces of the session runtime (spec 5.5 server flag, 6.2, 6.8, 6.11):
 * the server side-file flag recency test, the local.json lastLimit write, the acquire arguments
 * and heartbeat context of one open vault, the stale-file wait's starting markers, and a
 * bounded wait over host timers.
 * Part of session-runtime.ts.
 */

import { PRESENCE_FUTURE_TOLERANCE_MS } from '../sync/presence.js';
import type { ReplicaPort } from '../sync/replica.js';
import type { SessionRowView, SyncLogger, Timers } from '../sync/host.js';
import type { FileHint, SyncState } from '../sync/types.js';
import { effectiveLimit, lastLimitDue, LAST_LIMIT_REFRESH_MS, type EffectiveLimit } from './effective-limit.js';
import type { LeaseTracker } from './lease.js';
import type { HeartbeatContext } from './heartbeat.js';
import type { AcquireArgs, Ownership } from './session-client.js';
import type { OwnerCheck } from '../sync/types.js';
import { expectedMarkers, uncoveredMarkers, type ExpectedMarker } from './stale-wait.js';
import type { SessionHost } from './host.js';

/** 5.5: a side-file flag from another device counts for 2 hours. */
export const SERVER_SIDE_FILES_WINDOW_MS = 2 * 60 * 60 * 1000;

export const P = '[vault-session]';

export function errorMeta(err: unknown): { readonly error: string; readonly code: string | null } {
  const code = (err as { code?: unknown } | null)?.code;
  return { error: err instanceof Error ? err.name : typeof err, code: typeof code === 'string' ? code : null };
}

/** Runs `fn`, logging a failure under `what` (the runtime never lets one step stop the next). */
export function guarded(logger: SyncLogger, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.error(`${P} runtime step failed: ${what}`, errorMeta(err));
  }
}

/** When a row's flags were last reported: its heartbeat, or its last activity from an older server. */
function flagReportedMs(row: SessionRowView): number | null {
  return row.heartbeatAtMs ?? row.lastActiveMs;
}

/**
 * A session row with the side-file flag reported within 2 hours (and not more than 5 minutes
 * in the future) holds legacy changes on every device (5.5), unless it was reported at or
 * before this device's side-file confirmation (`confirmedAtServerMs`, on the server's clock
 * like the rows).
 */
export function sideFilesFlagRecent(sessions: readonly SessionRowView[], nowMs: number, confirmedAtServerMs: number | null = null): boolean {
  return sessions.some((row) => {
    const reportedMs = flagReportedMs(row);
    return (
      row.sideFilesFlag &&
      reportedMs !== null &&
      (confirmedAtServerMs === null || reportedMs > confirmedAtServerMs) &&
      reportedMs <= nowMs + PRESENCE_FUTURE_TOLERANCE_MS &&
      nowMs - reportedMs <= SERVER_SIDE_FILES_WINDOW_MS
    );
  });
}

/** sideFilesFlagRecent over the lease's rows, with the confirmation recorded in local.json. */
export function uncoveredSideFilesFlag(lease: LeaseTracker, replica: ReplicaPort | null, logger: SyncLogger, nowMs: number): boolean {
  const confirmedAtMs = readOr(logger, 'side-file confirmation', () => replica?.local().sideFilesConfirmedAtMs ?? null, null);
  return sideFilesFlagRecent(lease.sessions(), nowMs, confirmedAtMs === null ? null : lease.toServerMs(confirmedAtMs));
}

/** fn(), or `fallback` when it throws (logged as unavailable). */
export function readOr<T>(logger: SyncLogger, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logger.warn(`${P} ${what} unavailable`, errorMeta(err));
    return fallback;
  }
}

/** 6.8 effective limit of one open vault; an unreadable lastLimit or tier cache counts as absent. */
export function runtimeEffectiveLimit(host: SessionHost, lease: LeaseTracker, replica: ReplicaPort | null): EffectiveLimit {
  const nowMs = host.clock.now();
  return effectiveLimit({
    signedIn: host.account.userId() !== null,
    confirmed: lease.isConfirmed(nowMs),
    serverLimit: lease.serverLimit(),
    localLast: readOr(host.logger, 'lastLimit', () => replica?.local().lastLimit ?? null, null),
    tierCache: readOr(host.logger, 'tier cache', () => host.tierCache.read(), null),
    nowMs,
  });
}

/** 6.8: the server's limit into local.json lastLimit (the offline effective limit), when a write is due. */
export function recordLastLimit(replica: ReplicaPort | null, host: Pick<SessionHost, 'clock' | 'logger'>, limit: number): void {
  if (replica === null) return;
  const atMs = host.clock.now();
  guarded(host.logger, 'write lastLimit', () => {
    if (!lastLimitDue(replica.local().lastLimit, limit, atMs)) return;
    replica.updateLocal((l) => ({ ...l, lastLimit: { value: limit, atMs } }));
  });
}

/** 3.3: the ownerCheck a confirmed answer leads to; undefined keeps the stored one ('unowned' and unknown answers). */
export function ownerCheckFor(ownership: Ownership | null, hint: string, atMs: number): OwnerCheck | undefined {
  if (ownership?.kind === 'owner') return { hint, kind: 'owner', untilMs: null, atMs };
  if (ownership?.kind === 'grace') return { hint, kind: 'grace', untilMs: ownership.untilMs, atMs };
  return undefined;
}

/** A new check, or the same one gone stale (refreshed like lastLimit so an offline unlock compares a recent time). */
export function ownerCheckDue(prev: OwnerCheck | null, next: OwnerCheck): boolean {
  if (prev === null || prev.hint !== next.hint || prev.kind !== next.kind || prev.untilMs !== next.untilMs) return true;
  const ageMs = next.atMs - prev.atMs;
  return !(ageMs >= 0 && ageMs < LAST_LIMIT_REFRESH_MS);
}

/** 3.3: a confirmed grant or heartbeat `ok` into local.json ownerCheck, when a write is due. Shared vaults only. */
export function recordOwnerCheck(
  replica: ReplicaPort | null,
  host: Pick<SessionHost, 'clock' | 'logger'>,
  ownership: Ownership | null,
  hint: string | null,
): void {
  if (replica === null || hint === null) return;
  const next = ownerCheckFor(ownership, hint, host.clock.now());
  if (next === undefined) return;
  guarded(host.logger, 'write ownerCheck', () => {
    if (!ownerCheckDue(replica.local().ownerCheck ?? null, next)) return;
    replica.updateLocal((l) => ({ ...l, ownerCheck: next }));
  });
}

/** 3.3: a confirmed not-owner answer or a confirmed release clears the check. */
export function clearOwnerCheck(replica: ReplicaPort | null, host: Pick<SessionHost, 'logger'>): void {
  if (replica === null) return;
  guarded(host.logger, 'clear ownerCheck', () => {
    if ((replica.local().ownerCheck ?? null) === null) return;
    replica.updateLocal((l) => ({ ...l, ownerCheck: null }));
  });
}

export interface FileFacts {
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
}

export function factsFromHint(hint: FileHint | null, fallbackName: string | null): FileFacts {
  if (hint === null) return { fileName: fallbackName, fileId: null, location: null };
  return { fileName: hint.file_name, fileId: hint.file_id, location: hint.location };
}

export interface AcquireInputs {
  readonly vaultKey: string;
  readonly deviceId: string;
  readonly sessionNonce: string;
  readonly facts: FileFacts;
  readonly takeover: boolean;
  /** p_claim: true only for a take-over the user chose; background re-acquires never claim. */
  readonly claim: boolean;
}

export function acquireArgsFor(host: Pick<SessionHost, 'device'>, input: AcquireInputs): AcquireArgs {
  const device = host.device.current();
  return {
    vaultKey: input.vaultKey,
    deviceId: input.deviceId,
    sessionNonce: input.sessionNonce,
    deviceName: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    fileName: input.facts.fileName,
    fileId: input.facts.fileId,
    location: input.facts.location,
    takeover: input.takeover,
    claim: input.claim,
  };
}

export function heartbeatContextFor(facts: FileFacts, sideFilesPresent: boolean, pendingChanges: boolean): HeartbeatContext {
  return { ...facts, sideFilesPresent, pendingChanges };
}

/** 6.11 at open: markers of sessions on our file the last S read does not cover. */
export function startingMarkers(
  sessions: readonly SessionRowView[],
  ownFileId: string | null,
  abandonedWaits: readonly string[],
  lastShared: SyncState | null,
): readonly ExpectedMarker[] {
  const expected = expectedMarkers(sessions, ownFileId, abandonedWaits);
  return lastShared === null ? expected : uncoveredMarkers(expected, lastShared.vv);
}

export type Settled<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'timed-out' } | { readonly kind: 'failed' };

/** `p` or a timeout on host timers, whichever comes first; a rejection is logged as `what`. */
export async function settleWithin<T>(p: Promise<T>, ms: number, timers: Timers, logger: SyncLogger, what: string): Promise<Settled<T>> {
  let handle: { cancel(): void } | null = null;
  const timeout = new Promise<Settled<T>>((resolve) => {
    handle = timers.setTimeout(() => resolve({ kind: 'timed-out' }), ms);
  });
  const work = p.then(
    (value): Settled<T> => ({ kind: 'done', value }),
    (err: unknown): Settled<T> => {
      logger.error(`${P} ${what} failed`, errorMeta(err));
      return { kind: 'failed' };
    },
  );
  const res = await Promise.race([work, timeout]);
  (handle as { cancel(): void } | null)?.cancel();
  if (res.kind === 'timed-out') logger.warn(`${P} ${what} timed out`, { ms });
  return res;
}
