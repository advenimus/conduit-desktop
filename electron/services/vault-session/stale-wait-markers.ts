/**
 * Publish markers of spec 6.11 (part of stale-wait.ts): which session markers this device waits
 * for, which of them S covers, and the helpers shared by the stale wait and the G1 wait.
 */

import type { SessionRowView, SyncLogger, WaitingDevice, WaitingState } from '../sync/host.js';
import { vvCovers } from '../sync/sibling.js';
import type { AppDot, VersionVector } from '../sync/types.js';

/** 6.11: poll every 2 s. */
export const STALE_POLL_MS = 2_000;
/** 6.11: [Stop waiting for X] after 2 minutes; the wait counts as timed out then. */
export const STALE_STOP_OFFER_MS = 120_000;
/** 4.4 G1: wait up to 2 minutes for the synced file. */
export const G1_WAIT_MS = 120_000;
/** local.json abandoned_waits keeps the newest entries only. */
export const ABANDONED_WAITS_KEEP = 50;

export interface ExpectedMarker {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly marker: AppDot;
  readonly writtenAtMs: number | null;
}

export function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function errorMeta(err: unknown): { readonly error: string; readonly code: string | null } {
  const code = (err as { code?: unknown } | null)?.code;
  return { error: err instanceof Error ? err.name : typeof err, code: typeof code === 'string' ? code : null };
}

/** abandoned_waits entry: `<deviceId>|<dev>:<ms>:<c>` (a new marker is waited for again). */
export function abandonedKey(m: Pick<ExpectedMarker, 'deviceId' | 'marker'>): string {
  return `${m.deviceId.toLowerCase()}|${m.marker.dev}:${m.marker.ms}:${m.marker.c}`;
}

export function expectedMarkers(
  sessions: readonly SessionRowView[],
  ownFileId: string | null,
  abandonedWaits: readonly string[],
): readonly ExpectedMarker[] {
  if (ownFileId === null) return [];
  const skip = new Set(abandonedWaits);
  const out: ExpectedMarker[] = [];
  for (const row of sessions) {
    if (row.marker === null || row.fileId === null || row.abandoned) continue;
    if (!sameId(row.fileId, ownFileId)) continue;
    const m: ExpectedMarker = { deviceId: row.deviceId, deviceName: row.deviceName, marker: row.marker, writtenAtMs: row.writtenAtMs };
    if (!skip.has(abandonedKey(m))) out.push(m);
  }
  return out;
}

/** Markers S does not cover (sibling.vvCovers). */
export function uncoveredMarkers(expected: readonly ExpectedMarker[], sharedVv: VersionVector): readonly ExpectedMarker[] {
  return expected.filter((m) => !vvCovers(sharedVv, m.marker.dev, m.marker));
}

/** One entry per device, with the newest written_at among its markers. */
export function waitingDevices(markers: readonly ExpectedMarker[]): readonly WaitingDevice[] {
  const byId = new Map<string, WaitingDevice>();
  for (const m of markers) {
    const key = m.deviceId.toLowerCase();
    const prev = byId.get(key);
    const savedAtMs = Math.max(prev?.savedAtMs ?? -Infinity, m.writtenAtMs ?? -Infinity);
    byId.set(key, { deviceId: m.deviceId, deviceName: m.deviceName, savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : null });
  }
  return [...byId.values()];
}

export function setWaitingSafely(set: (w: WaitingState | null) => void, w: WaitingState | null, logger: SyncLogger): void {
  try {
    set(w);
  } catch (err) {
    logger.error('[vault-session] could not update the waiting state', errorMeta(err));
  }
}
