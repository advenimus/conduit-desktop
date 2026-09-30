/**
 * Strict parsers of the session RPC answers (spec 9.4 vault_sessions_for / vault_session_holders
 * rows, 9.5 peek, acquire and heartbeat objects) and the written_vv marker codec. Pure. Anything
 * that does not match the SQL's shapes is reported as malformed, which the client turns into an
 * unconfirmed answer. Part of session-client.ts.
 */

import type { SessionRowView, SessionStatus } from '../sync/host.js';
import { DEV_BITS, HLC_MAX_COUNTER, type AppDot } from '../sync/types.js';
import type { Holder } from './host.js';
import type { AcquireResult, HeartbeatResult } from './session-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DEV_KEY_RE = /^[1-9][0-9]*$/;
const MAX_DEV = 2 ** DEV_BITS - 1;
/** vault_max_open_devices: -1 means unlimited; otherwise at least one device. */
const UNLIMITED_LIMIT = -1;
const SESSION_STATUSES: ReadonlySet<string> = new Set<SessionStatus>(['active', 'released', 'expired', 'displaced']);
const DISPLACED_REASONS: ReadonlySet<string> = new Set(['takeover', 'plan_limit']);
const LOST_REASONS: ReadonlySet<string> = new Set(['unknown', 'superseded', 'released', 'expired']);
const SIDE_FILES_PRESENT = 'present';

export type Parsed<T> =
  | { readonly ok: true; readonly value: T; readonly skipped: number }
  | { readonly ok: false; readonly detail: string };

export interface PeekData {
  readonly limit: number;
  readonly holders: readonly Holder[];
}

// ---------- Primitive checks ----------

export function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isServerLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && (v === UNLIMITED_LIMIT || v >= 1);
}

/** ms for an ISO timestamp, null for null/absent, undefined when present but invalid. */
function timestampMs(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !ISO_TIMESTAMP_RE.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/** string or null; undefined when present with another type. */
function optionalText(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : undefined;
}

function optionalUuid(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return isUuid(v) ? v.toLowerCase() : undefined;
}

/** Busy counts are written by other clients: anything but a non-negative number counts as 0. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : 0;
}

function busyCounts(v: unknown): { readonly sessions: number; readonly jobs: number } {
  if (!isRecord(v)) return { sessions: 0, jobs: 0 };
  return { sessions: count(v.sessions), jobs: count(v.jobs) };
}

// ---------- Marker (written_vv) ----------

/** {"<dev>": [ms, c]} for p_written_vv. */
export function markerToJson(marker: AppDot): Readonly<Record<string, readonly [number, number]>> {
  return { [String(marker.dev)]: [marker.ms, marker.c] };
}

/** Parses written_vv; null for {} or anything that is not exactly one valid entry. */
export function markerFromJson(raw: unknown): AppDot | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (!DEV_KEY_RE.test(key)) return null;
  const dev = Number(key);
  if (!Number.isSafeInteger(dev) || dev > MAX_DEV) return null;
  const pair = raw[key];
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [ms, c] = pair as readonly unknown[];
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) return null;
  if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0 || c > HLC_MAX_COUNTER) return null;
  return { dev, ms, c };
}

// ---------- Rows ----------

interface CommonRow {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly lastActiveMs: number | null;
  readonly busySessions: number;
  readonly busyJobs: number;
}

function parseCommon(r: Readonly<Record<string, unknown>>): CommonRow | null {
  if (!isUuid(r.device_id)) return null;
  if (typeof r.device_name !== 'string' || r.device_name.length === 0) return null;
  if (typeof r.platform !== 'string' || r.platform.length === 0) return null;
  const fileName = optionalText(r.file_name);
  const fileId = optionalUuid(r.file_id);
  const location = optionalText(r.location);
  const lastActiveMs = timestampMs(r.last_active_at);
  if (fileName === undefined || fileId === undefined || location === undefined || lastActiveMs === undefined) return null;
  const busy = busyCounts(r.busy);
  return {
    deviceId: r.device_id.toLowerCase(),
    deviceName: r.device_name,
    platform: r.platform,
    fileName,
    fileId,
    location,
    lastActiveMs,
    busySessions: busy.sessions,
    busyJobs: busy.jobs,
  };
}

function parseSessionRow(raw: unknown): SessionRowView | null {
  if (!isRecord(raw)) return null;
  const common = parseCommon(raw);
  if (common === null) return null;
  if (typeof raw.status !== 'string' || !SESSION_STATUSES.has(raw.status)) return null;
  if (typeof raw.pending_changes !== 'boolean' || typeof raw.abandoned !== 'boolean') return null;
  const writtenAtMs = timestampMs(raw.written_at);
  const heartbeatAtMs = timestampMs(raw.heartbeat_at);
  if (writtenAtMs === undefined || heartbeatAtMs === undefined) return null;
  return {
    ...common,
    heartbeatAtMs,
    status: raw.status as SessionStatus,
    sideFilesFlag: isRecord(raw.flags) && raw.flags.side_files === SIDE_FILES_PRESENT,
    marker: markerFromJson(raw.written_vv),
    writtenAtMs,
    pendingChanges: raw.pending_changes,
    abandoned: raw.abandoned,
  };
}

function parseHolder(raw: unknown): Holder | null {
  return isRecord(raw) ? parseCommon(raw) : null;
}

function parseList<T>(raw: unknown, parseOne: (v: unknown) => T | null): { readonly rows: readonly T[]; readonly skipped: number } {
  if (!Array.isArray(raw)) return { rows: [], skipped: 0 };
  const rows: T[] = [];
  for (const item of raw) {
    const row = parseOne(item);
    if (row !== null) rows.push(row);
  }
  return { rows, skipped: raw.length - rows.length };
}

/** Parses vault_sessions_for output; invalid rows are skipped (and logged by the caller). */
export function parseSessions(raw: unknown): readonly SessionRowView[] {
  return parseList(raw, parseSessionRow).rows;
}

export function parseHolders(raw: unknown): readonly Holder[] {
  return parseList(raw, parseHolder).rows;
}

// ---------- RPC answers ----------

const malformed = (detail: string): Parsed<never> => ({ ok: false, detail });

export function parsePeekData(data: unknown): Parsed<PeekData> {
  if (!isRecord(data)) return malformed('peek: not an object');
  if (!isServerLimit(data.limit)) return malformed('peek: limit');
  if (!Array.isArray(data.holders)) return malformed('peek: holders');
  const holders = parseList(data.holders, parseHolder);
  return { ok: true, value: { limit: data.limit, holders: holders.rows }, skipped: holders.skipped };
}

export function parseAcquireData(data: unknown): Parsed<AcquireResult> {
  if (!isRecord(data) || typeof data.granted !== 'boolean') return malformed('acquire: granted');
  if (data.granted === false && data.error === 'too_many_sessions') {
    return { ok: true, value: { kind: 'unconfirmed', reason: 'too-many-sessions', detail: 'too_many_sessions' }, skipped: 0 };
  }
  if (!isServerLimit(data.limit)) return malformed('acquire: limit');
  if (!Array.isArray(data.sessions)) return malformed('acquire: sessions');
  const serverNowMs = timestampMs(data.server_now);
  if (serverNowMs === undefined) return malformed('acquire: server_now');
  const sessions = parseList(data.sessions, parseSessionRow);
  if (data.granted) {
    if (!isUuid(data.lease_id)) return malformed('acquire: lease_id');
    const value: AcquireResult = { kind: 'granted', leaseId: data.lease_id.toLowerCase(), limit: data.limit, sessions: sessions.rows, serverNowMs };
    return { ok: true, value, skipped: sessions.skipped };
  }
  if (!Array.isArray(data.holders)) return malformed('acquire: holders');
  const holders = parseList(data.holders, parseHolder);
  // A denial must name who holds the vault; an empty list is a server problem, never a refusal.
  if (holders.rows.length === 0) return malformed('acquire: denied without holders');
  const value: AcquireResult = { kind: 'denied', limit: data.limit, holders: holders.rows, sessions: sessions.rows, serverNowMs };
  return { ok: true, value, skipped: sessions.skipped + holders.skipped };
}

function parseHeartbeatOk(data: Readonly<Record<string, unknown>>): Parsed<HeartbeatResult> {
  if (!isServerLimit(data.limit)) return malformed('heartbeat: limit');
  if (!Array.isArray(data.sessions)) return malformed('heartbeat: sessions');
  const serverNowMs = timestampMs(data.server_now);
  if (serverNowMs === undefined) return malformed('heartbeat: server_now');
  const sessions = parseList(data.sessions, parseSessionRow);
  return { ok: true, value: { kind: 'ok', limit: data.limit, sessions: sessions.rows, serverNowMs }, skipped: sessions.skipped };
}

export function parseHeartbeatData(data: unknown): Parsed<HeartbeatResult> {
  if (!isRecord(data)) return malformed('heartbeat: not an object');
  if (data.status === 'ok') return parseHeartbeatOk(data);
  if (data.status === 'displaced') {
    if (typeof data.reason !== 'string' || !DISPLACED_REASONS.has(data.reason)) return malformed('heartbeat: displaced reason');
    const by = optionalText(data.by);
    if (by === undefined) return malformed('heartbeat: displaced by');
    const reason = data.reason as 'takeover' | 'plan_limit';
    return { ok: true, value: { kind: 'displaced', reason, byDeviceName: by }, skipped: 0 };
  }
  if (data.status === 'lost') {
    if (typeof data.reason !== 'string' || !LOST_REASONS.has(data.reason)) return malformed('heartbeat: lost reason');
    const reason = data.reason as 'unknown' | 'superseded' | 'released' | 'expired';
    return { ok: true, value: { kind: 'lost', reason }, skipped: 0 };
  }
  return malformed('heartbeat: status');
}
