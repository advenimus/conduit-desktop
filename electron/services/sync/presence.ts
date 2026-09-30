/**
 * Presence registers (spec 3.5 `_sync/device/<device_uuid>`, 5.3 step 1, 5.8, 6.7, 6.11):
 * builds this device's presence value (the publish marker's payload), parses every device's
 * provisional presence, and the activity test used by owner-claim prompts and the signed-out
 * stale-file hint. Pure.
 */

import { SYNC_ROW, deviceRegKey } from './catalog.js';
import { getRegister, provisional, rowKeyStr } from './state-view.js';
import type { DeviceInfo } from './host.js';
import { TBL, type AppDot, type FileHint, type PresenceValue, type SyncState } from './types.js';

/** 6.2 / 6.7: a claim prompt needs activity within 15 minutes. */
export const CLAIM_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;
/** 6.2: presence times more than 5 minutes in the future are ignored. */
export const PRESENCE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface PresenceFields {
  readonly device: DeviceInfo;
  readonly nowMs: number;
  readonly sessionOpen: boolean;
  /** Start of the current open session (unlock time), null when closed. */
  readonly sessionSinceMs: number | null;
  /** hashing.accountHint(lineage, userId) or null when signed out. */
  readonly accountHint: string | null;
  readonly fileHint: FileHint | null;
  /** Last time this device saw side files next to S, else null. */
  readonly sideFilesSeenMs: number | null;
}

export interface PresenceEntry {
  readonly deviceUuid: string;
  readonly value: PresenceValue;
  /** Dot of the provisional sibling when it is an app sibling; null for pseudo siblings. */
  readonly dot: AppDot | null;
}

/**
 * New presence value: first_seen_ms kept from `prev` (else nowMs), last_active_ms = nowMs,
 * every other field from `f`. Deterministic key order is jcs's job (capture-local.presenceWrite).
 */
export function buildPresence(prev: PresenceValue | null, f: PresenceFields): PresenceValue {
  return Object.freeze({
    platform: f.device.platform,
    name: f.device.name,
    app_version: f.device.appVersion,
    first_seen_ms: prev?.first_seen_ms ?? f.nowMs,
    last_active_ms: f.nowMs,
    session_open: f.sessionOpen ? 1 : 0,
    session_since_ms: f.sessionSinceMs,
    account_hint: f.accountHint,
    file_hint: f.fileHint === null ? null : Object.freeze({ ...f.fileHint }),
    side_files_seen_ms: f.sideFilesSeenMs,
  });
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || isNum(v);
}

function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The file hint, null when absent, undefined when malformed. */
function parseHint(v: unknown): FileHint | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  const { file_id, location, file_name } = v;
  if (typeof file_id !== 'string' || typeof location !== 'string' || typeof file_name !== 'string') return undefined;
  return Object.freeze({ file_id, location, file_name });
}

function hasPresenceShape(o: Record<string, unknown>): boolean {
  return (
    typeof o.platform === 'string' &&
    typeof o.name === 'string' &&
    typeof o.app_version === 'string' &&
    isNum(o.first_seen_ms) &&
    isNum(o.last_active_ms) &&
    (o.session_open === 0 || o.session_open === 1) &&
    isNumOrNull(o.session_since_ms) &&
    isStrOrNull(o.account_hint) &&
    isNumOrNull(o.side_files_seen_ms)
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parses a presence JCS text; null when it is not an object with the PresenceValue fields. */
export function parsePresence(text: string): PresenceValue | null {
  const raw = parseJson(text);
  if (!isObject(raw) || !hasPresenceShape(raw)) return null;
  const hint = parseHint(raw.file_hint);
  if (hint === undefined) return null;
  return Object.freeze({
    platform: raw.platform as string,
    name: raw.name as string,
    app_version: raw.app_version as string,
    first_seen_ms: raw.first_seen_ms as number,
    last_active_ms: raw.last_active_ms as number,
    session_open: raw.session_open as 0 | 1,
    session_since_ms: raw.session_since_ms as number | null,
    account_hint: raw.account_hint as string | null,
    file_hint: hint,
    side_files_seen_ms: raw.side_files_seen_ms as number | null,
  });
}

/** Provisional presence of one device (explicit register only), or null. */
export function readPresence(state: SyncState, deviceUuid: string): PresenceEntry | null {
  const key = deviceRegKey(deviceUuid);
  const reg = getRegister(state, key);
  if (reg === undefined) return null;
  const top = provisional(key.reg, reg.sibs);
  if (top === null || typeof top.value !== 'string') return null;
  const value = parsePresence(top.value);
  if (value === null) return null;
  const dot: AppDot | null = top.dev > 0 ? Object.freeze({ dev: top.dev, ms: top.ms, c: top.c }) : null;
  return Object.freeze({ deviceUuid, value, dot });
}

/** Every device's provisional presence, sorted by deviceUuid; unparseable values skipped (logged by caller). */
export function listPresence(state: SyncState): readonly PresenceEntry[] {
  const row = state.rows.get(rowKeyStr({ tbl: TBL.sync, rowId: SYNC_ROW.device }));
  if (row === undefined) return Object.freeze([]);
  const out: PresenceEntry[] = [];
  for (const uuid of [...row.regs.keys()].sort()) {
    const entry = readPresence(state, uuid);
    if (entry !== null) out.push(entry);
  }
  return Object.freeze(out);
}

/**
 * 6.7 prompt test: session_open = 1 and last_active_ms within `windowMs` of nowMs. A
 * last_active_ms more than PRESENCE_FUTURE_TOLERANCE_MS in the future counts as not active.
 */
export function isRecentlyActive(p: PresenceValue, nowMs: number, windowMs: number = CLAIM_ACTIVITY_WINDOW_MS): boolean {
  if (p.session_open !== 1) return false;
  if (p.last_active_ms > nowMs + PRESENCE_FUTURE_TOLERANCE_MS) return false;
  return nowMs - p.last_active_ms <= windowMs;
}

function sameHint(a: FileHint | null, b: FileHint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.file_id === b.file_id && a.location === b.location && a.file_name === b.file_name;
}

/** true when every field except last_active_ms is equal (decides "a field changed", 3.5). */
export function samePresenceIgnoringActivity(a: PresenceValue, b: PresenceValue): boolean {
  return (
    a.platform === b.platform &&
    a.name === b.name &&
    a.app_version === b.app_version &&
    a.first_seen_ms === b.first_seen_ms &&
    a.session_open === b.session_open &&
    a.session_since_ms === b.session_since_ms &&
    a.account_hint === b.account_hint &&
    a.side_files_seen_ms === b.side_files_seen_ms &&
    sameHint(a.file_hint, b.file_hint)
  );
}
