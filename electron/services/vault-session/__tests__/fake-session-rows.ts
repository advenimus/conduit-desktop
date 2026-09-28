// Rows of the in-memory personal_vault_sessions table and the JSON the SQL builds from them
// (spec 9.4: vault_session_holders, vault_sessions_for, the Realtime row payload). Test helper
// of fake-session-server.ts.

export const LEASE_TTL_MS = 90_000;
export const SESSIONS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const TOO_MANY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TOO_MANY_LIMIT = 200;
export const JSON_SMALL_LIMIT = 256;
export const JSON_MARKER_LIMIT = 1024;
export const PLATFORMS: ReadonlySet<string> = new Set(['macos', 'windows', 'linux', 'ios', 'ipados']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RowStatus = 'active' | 'released' | 'expired' | 'displaced';
export type Json = Readonly<Record<string, unknown>>;

export interface SessionRow {
  readonly userId: string;
  readonly vaultKey: string;
  readonly deviceId: string;
  readonly leaseId: string;
  readonly sessionNonce: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion: string | null;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly status: RowStatus;
  readonly acquiredAtMs: number;
  readonly heartbeatAtMs: number;
  readonly expiresAtMs: number;
  readonly lastActiveMs: number;
  readonly busy: Json;
  readonly flags: Json;
  readonly displacedByDevice: string | null;
  readonly displacedReason: 'takeover' | 'plan_limit' | null;
  readonly displacedAtMs: number | null;
  readonly writtenVv: Json;
  readonly writtenAtMs: number | null;
  readonly pendingChanges: boolean;
  readonly abandonedAtMs: number | null;
}

/** A Postgres error raised by the emulated SQL (SQLSTATE in `code`). */
export class SqlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

export function rowKey(userId: string, vaultKey: string, deviceId: string): string {
  return `${userId}|${vaultKey.toLowerCase()}|${deviceId.toLowerCase()}`;
}

export function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function sameId(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** A uuid parameter: null stays null, anything else must parse (22P02 like Postgres). */
export function uuidArg(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new SqlError('22P02', `invalid input syntax for type uuid: ${name}`);
  return v.toLowerCase();
}

export function textArg(v: unknown, max: number | null = null): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return max === null ? s : s.slice(0, max);
}

export function jsonArg(v: unknown): Json | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new SqlError('23514', 'jsonb value is not an object');
  return v as Json;
}

function jsonBytes(v: Json): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

/** The table's CHECK constraints (9.4); a violation is SQLSTATE 23514. */
export function checkRow(row: SessionRow): void {
  const fail = (what: string): never => {
    throw new SqlError('23514', `new row violates check constraint (${what})`);
  };
  if (row.deviceName.length < 1 || row.deviceName.length > 120) fail('device_name');
  if (!PLATFORMS.has(row.platform)) fail('platform');
  if (row.appVersion !== null && row.appVersion.length > 40) fail('app_version');
  if (jsonBytes(row.busy) > JSON_SMALL_LIMIT) fail('busy');
  if (jsonBytes(row.flags) > JSON_SMALL_LIMIT) fail('flags');
  if (jsonBytes(row.writtenVv) > JSON_MARKER_LIMIT) fail('written_vv');
}

/** vault_session_is_busy(busy). */
export function isBusy(busy: Json): boolean {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return n(busy.sessions) > 0 || n(busy.jobs) > 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Take-over order (9.5 acquire): not busy first, least recently active first, device_id. */
export function takeoverOrder(a: SessionRow, b: SessionRow): number {
  return Number(isBusy(a.busy)) - Number(isBusy(b.busy)) || a.lastActiveMs - b.lastActiveMs || compareIds(a.deviceId, b.deviceId);
}

/** Plan-limit ranking (9.5 heartbeat): busy first, most recently active first, device_id. */
export function keepOrder(a: SessionRow, b: SessionRow): number {
  return Number(isBusy(b.busy)) - Number(isBusy(a.busy)) || b.lastActiveMs - a.lastActiveMs || compareIds(a.deviceId, b.deviceId);
}

export function holderJson(r: SessionRow): Json {
  return {
    device_id: r.deviceId,
    device_name: r.deviceName,
    platform: r.platform,
    file_name: r.fileName,
    file_id: r.fileId,
    location: r.location,
    last_active_at: iso(r.lastActiveMs),
    busy: r.busy,
  };
}

export function sessionJson(r: SessionRow, nowMs: number): Json {
  return {
    ...holderJson(r),
    status: r.status === 'active' && r.expiresAtMs < nowMs ? 'expired' : r.status,
    heartbeat_at: iso(r.heartbeatAtMs),
    flags: r.flags,
    written_vv: r.writtenVv,
    written_at: iso(r.writtenAtMs),
    pending_changes: r.pendingChanges,
    abandoned: r.abandonedAtMs !== null,
  };
}

/** The Realtime postgres_changes `new` record (column names as in the table). */
export function realtimeJson(r: SessionRow): Json {
  return {
    user_id: r.userId,
    vault_key: r.vaultKey,
    device_id: r.deviceId,
    lease_id: r.leaseId,
    session_nonce: r.sessionNonce,
    device_name: r.deviceName,
    platform: r.platform,
    status: r.status,
    expires_at: iso(r.expiresAtMs),
    last_active_at: iso(r.lastActiveMs),
    displaced_by_device: r.displacedByDevice,
    displaced_reason: r.displacedReason,
    written_vv: r.writtenVv,
    pending_changes: r.pendingChanges,
  };
}
