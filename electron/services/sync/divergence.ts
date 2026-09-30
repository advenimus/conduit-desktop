/**
 * Different copies across devices (spec 5.8 "Different copies across devices", 12 row 48):
 * another device of this lineage reports a different file_id or provider kind (presence
 * file_hint or session row), or the same file_id but its publish marker stayed uncovered by
 * S for 24 hours while both devices published. Produces the "These are separate copies"
 * prompt with [Merge them...] [Keep separate] [Remind me later]. Signed-out devices on
 * different copies cannot be detected. The 24 h timers live in memory (a restart restarts
 * them).
 */

import { locationKind } from './file-binding-provider.js';
import { listPresence } from './presence.js';
import { vvCovers } from './sibling.js';
import type { SessionRowView } from './host.js';
import type { FileHint, SyncState, VersionVector } from './types.js';

/** 5.8: same file_id but a marker uncovered for 24 hours while both devices published. */
export const DIVERGENCE_UNCOVERED_MS = 24 * 60 * 60 * 1000;
/** [Remind me later] snooze. */
export const DIVERGENCE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export type DivergenceFinding =
  | {
      readonly kind: 'different-file';
      readonly deviceUuid: string;
      readonly deviceName: string;
      readonly theirs: FileHint;
      readonly ours: FileHint;
    }
  | {
      readonly kind: 'marker-uncovered';
      readonly deviceUuid: string;
      readonly deviceName: string;
      readonly sinceMs: number;
      readonly theirs: FileHint;
      readonly ours: FileHint;
    };

export interface DivergenceInput {
  /** M after the merge (presence registers with file_hint). */
  readonly state: SyncState;
  readonly ownDeviceUuid: string;
  readonly ownHint: FileHint;
  readonly sessions: readonly SessionRowView[];
  /** S's version vector as last read (null when S was not read). */
  readonly sharedVv: VersionVector | null;
  readonly nowMs: number;
  /** This device's last successful publish time (the "both devices published" condition). */
  readonly lastOwnPublishMs: number | null;
}

interface DeviceHint {
  readonly deviceUuid: string;
  readonly deviceName: string;
  readonly hint: FileHint;
  readonly activeMs: number | null;
}

function sessionHint(row: SessionRowView): FileHint | null {
  if (row.fileId === null) return null;
  return { file_id: row.fileId, location: row.location ?? '', file_name: row.fileName ?? '' };
}

/** Newest report per device: presence file_hint, or the session row when it is newer (or presence has none). */
function hintsByDevice(state: SyncState, ownDeviceUuid: string, sessions: readonly SessionRowView[]): Map<string, DeviceHint> {
  const out = new Map<string, DeviceHint>();
  for (const p of listPresence(state)) {
    if (p.deviceUuid === ownDeviceUuid || p.value.file_hint === null) continue;
    out.set(p.deviceUuid, { deviceUuid: p.deviceUuid, deviceName: p.value.name, hint: p.value.file_hint, activeMs: p.value.last_active_ms });
  }
  for (const row of sessions) {
    const hint = sessionHint(row);
    if (row.deviceId === ownDeviceUuid || hint === null) continue;
    const prev = out.get(row.deviceId);
    const newer = prev === undefined || (row.lastActiveMs !== null && (prev.activeMs === null || row.lastActiveMs > prev.activeMs));
    if (newer) out.set(row.deviceId, { deviceUuid: row.deviceId, deviceName: row.deviceName, hint, activeMs: row.lastActiveMs });
  }
  return out;
}

function differs(theirs: FileHint, ours: FileHint): boolean {
  if (theirs.file_id !== ours.file_id) return true;
  const a = locationKind(theirs.location);
  const b = locationKind(ours.location);
  return a !== '' && b !== '' && a !== b;
}

function byDevice(a: DivergenceFinding, b: DivergenceFinding): number {
  return a.deviceUuid < b.deviceUuid ? -1 : a.deviceUuid > b.deviceUuid ? 1 : 0;
}

/** Pure part: devices whose file_id or provider kind (location prefix) differs from ours. */
export function detectDifferentFiles(
  state: SyncState,
  ownDeviceUuid: string,
  ownHint: FileHint,
  sessions: readonly SessionRowView[],
): readonly DivergenceFinding[] {
  const out: DivergenceFinding[] = [];
  for (const d of hintsByDevice(state, ownDeviceUuid, sessions).values()) {
    if (differs(d.hint, ownHint)) {
      out.push({ kind: 'different-file', deviceUuid: d.deviceUuid, deviceName: d.deviceName, theirs: d.hint, ours: ownHint });
    }
  }
  return out.sort(byDevice);
}

export interface DivergencePort {
  /** All current findings, minus snoozed and dismissed devices. Tracks marker-uncovered start times in memory. */
  observe(input: DivergenceInput): readonly DivergenceFinding[];
  /** [Remind me later]. */
  snooze(deviceUuid: string, nowMs: number): void;
  /** [Keep separate] ran (fork done) or [Merge them...] merged: stop prompting for this device and file_id. */
  dismiss(deviceUuid: string, theirFileId: string): void;
}

export class DivergenceTracker implements DivergencePort {
  /** device -> first time its markers were seen uncovered while we kept publishing. */
  private readonly uncoveredSince = new Map<string, number>();
  private readonly snoozedUntil = new Map<string, number>();
  /** device -> their file_id when dismissed; a different file_id prompts again. */
  private readonly dismissed = new Map<string, string>();

  observe(input: DivergenceInput): readonly DivergenceFinding[] {
    const different = detectDifferentFiles(input.state, input.ownDeviceUuid, input.ownHint, input.sessions);
    const flagged = new Set(different.map((f) => f.deviceUuid));
    const uncovered = this.markerFindings(input, flagged);
    return [...different, ...uncovered].filter((f) => this.visible(f, input.nowMs)).sort(byDevice);
  }

  snooze(deviceUuid: string, nowMs: number): void {
    this.snoozedUntil.set(deviceUuid, nowMs + DIVERGENCE_SNOOZE_MS);
  }

  dismiss(deviceUuid: string, theirFileId: string): void {
    this.dismissed.set(deviceUuid, theirFileId);
  }

  private markerFindings(input: DivergenceInput, skip: ReadonlySet<string>): DivergenceFinding[] {
    const out: DivergenceFinding[] = [];
    const tracked = new Set<string>();
    for (const row of input.sessions) {
      if (row.deviceId === input.ownDeviceUuid || skip.has(row.deviceId) || row.fileId !== input.ownHint.file_id) continue;
      tracked.add(row.deviceId);
      const since = this.trackMarker(row, input);
      if (since === null || input.nowMs - since < DIVERGENCE_UNCOVERED_MS) continue;
      const theirs = sessionHint(row) ?? input.ownHint;
      out.push({ kind: 'marker-uncovered', deviceUuid: row.deviceId, deviceName: row.deviceName, sinceMs: since, theirs, ours: input.ownHint });
    }
    for (const device of [...this.uncoveredSince.keys()]) if (!tracked.has(device)) this.uncoveredSince.delete(device);
    return out;
  }

  /** Start of the device's continuous uncovered period, or null when it is covered (timer reset). */
  private trackMarker(row: SessionRowView, input: DivergenceInput): number | null {
    const marker = row.marker;
    const stale =
      marker === null ||
      row.abandoned ||
      row.writtenAtMs === null ||
      input.lastOwnPublishMs === null ||
      input.lastOwnPublishMs <= row.writtenAtMs;
    if (stale) {
      this.uncoveredSince.delete(row.deviceId);
      return null;
    }
    // S not read this time: no evidence either way, the running period continues.
    if (input.sharedVv === null) return this.uncoveredSince.get(row.deviceId) ?? null;
    if (vvCovers(input.sharedVv, marker.dev, marker)) {
      this.uncoveredSince.delete(row.deviceId);
      return null;
    }
    const since = this.uncoveredSince.get(row.deviceId) ?? input.nowMs;
    this.uncoveredSince.set(row.deviceId, since);
    return since;
  }

  private visible(f: DivergenceFinding, nowMs: number): boolean {
    const until = this.snoozedUntil.get(f.deviceUuid);
    if (until !== undefined && nowMs < until) return false;
    if (until !== undefined) this.snoozedUntil.delete(f.deviceUuid);
    const dismissedId = this.dismissed.get(f.deviceUuid);
    if (dismissedId === undefined) return true;
    if (dismissedId === f.theirs.file_id) return false;
    this.dismissed.delete(f.deviceUuid);
    return true;
  }
}
