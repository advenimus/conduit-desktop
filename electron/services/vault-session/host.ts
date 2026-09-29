/**
 * Host interfaces of the device-session layer (docs/MULTI_DEVICE_SYNC.md 6.x, 9.4, 9.5):
 * the Supabase RPC caller and Realtime subscriber, power/idle/focus/busy providers, the tier
 * cache, vault access control for the soft lock, and the session events to the renderer.
 * Shared host pieces (clock, timers, logger, fs, random, kdf, account) come from
 * ../sync/host.ts. The integration workflow provides the Electron and supabase-js adapters.
 * Types and constants only.
 */

import type { RendererEmitter, SyncHost } from '../sync/host.js';

// ---------- Supabase RPC (9.5) ----------

export type SessionRpcName =
  | 'vault_session_peek'
  | 'vault_session_acquire'
  | 'vault_session_heartbeat'
  | 'vault_session_release'
  | 'vault_session_abandon'
  | 'vault_owner_release';

export type RpcFailureKind =
  /** fetch failed, DNS, connection reset, offline. */
  | 'network'
  | 'timeout'
  /** HTTP error without a Postgres error body (5xx, 404 from a gateway...). */
  | 'http'
  /** PostgREST returned a Postgres error: `code` is the SQLSTATE (28000, 22023, 23514...). */
  | 'postgres';

export interface RpcFailure {
  readonly kind: RpcFailureKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}

export type RpcResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly failure: RpcFailure };

/**
 * supabase.rpc(fn, args) with the signed-in user's JWT. Never rejects: adapters turn thrown
 * errors into { ok: false }. Argument names are the SQL parameter names (p_vault_key, ...).
 */
export interface RpcCaller {
  call(fn: SessionRpcName, args: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<RpcResult>;
}

// ---------- Realtime (9.5 notes) ----------

export type RealtimeStatus = 'subscribed' | 'closed' | 'error' | 'timed-out';

export interface RealtimeHandlers {
  /** postgres_changes UPDATE payload `new` of the device's own row (RLS limits to own user). */
  onUpdate(row: Readonly<Record<string, unknown>>): void;
  onStatus(status: RealtimeStatus): void;
}

export interface RealtimeSubscription {
  unsubscribe(): void;
}

export interface RealtimeHost {
  /** UPDATE on personal_vault_sessions with filter device_id=eq.<deviceId>; reconnect is the adapter's job. */
  subscribeOwnSessionRows(deviceId: string, handlers: RealtimeHandlers): RealtimeSubscription;
}

// ---------- Power, activity, busy (6.2) ----------

export interface PowerHost {
  /** Electron powerMonitor 'suspend'; returns an unsubscribe function. */
  onSuspend(fn: () => void): () => void;
  onResume(fn: () => void): () => void;
  /** powerMonitor.getSystemIdleTime() in seconds. */
  systemIdleSeconds(): number;
}

export interface ActivityHost {
  /** Main window focused now. */
  isFocused(): boolean;
  /** Last time the main window had focus (ms), null if never. */
  lastFocusMs(): number | null;
}

export interface BusyReport {
  /** Open terminal/RDP/VNC/web/command sessions. */
  readonly sessions: number;
  /** Running MCP or agent jobs. */
  readonly jobs: number;
}

export interface BusyHost {
  busy(): BusyReport;
}

// ---------- Tier cache (6.8) ----------

export interface CachedTierLimit {
  /** tiers.features.vault_max_open_devices from cached_tier_capabilities (null when absent). */
  readonly vaultMaxOpenDevices: number | null;
  /** cached_tier_timestamp (ms). */
  readonly timestampMs: number;
}

export interface TierCacheHost {
  read(): CachedTierLimit | null;
}

// ---------- Vault access (6.6 soft lock) ----------

/** device_cap soft-locks as open_elsewhere (plan enforcement 4.2). */
export type LockedReason = 'open_elsewhere' | 'not_owner' | 'update_required';

export interface VaultAccessHost {
  /** 6.6 step 1: overlay; vault IPC and MCP calls fail with the locked error and `reason`. */
  blockAccess(reason: LockedReason): void;
  /**
   * 6.6 step 4: stop backups, clear the vault key and master-password buffer, keep terminals,
   * RDP, VNC, web sessions and running commands. W's connection is closed by the replica first.
   */
  softLock(reason: LockedReason): void;
  /** Private (unshared) vaults open in place through the existing unlock path (3.2). */
  openPrivateInPlace(path: string, password: string): Promise<void>;
  /** vault_create / vault_initialize of a private vault (ConduitVault.initialize in place). */
  createPrivateInPlace(path: string, password: string): Promise<void>;
}

// ---------- Renderer events ----------

/** 'yielded': the user chose [Lock here] in the reconnect conflict (6.8). */
export type DisplacementReason =
  | 'takeover'
  | 'plan_limit'
  | 'device_cap'
  | 'not_owner'
  | 'update_required'
  | 'owner_claim'
  | 'superseded'
  | 'reconnect_unanswered'
  | 'yielded';

/** What the displaced notice needs beyond the reason (plan enforcement S8b, S10). */
export interface DisplacedDetail {
  readonly minVersion: string | null;
  readonly released: boolean;
}

export const NO_DISPLACED_DETAIL: DisplacedDetail = Object.freeze({ minVersion: null, released: false });

export interface Holder {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly lastActiveMs: number | null;
  readonly busySessions: number;
  readonly busyJobs: number;
  /** Device-cap holders (plan enforcement 2.4): personal vaults this device has open; null when not sent. */
  readonly vaults?: number | null;
}

/** `vault:session-displacing` (6.6 step 1 overlay): access is blocked while the last changes save. */
export interface SessionDisplacingEvent {
  readonly lineageId: string;
  readonly reason: DisplacementReason;
  readonly byDeviceName: string | null;
}

/** `vault:session-displaced` (6.6 step 5 modal). */
export interface SessionDisplacedEvent {
  readonly lineageId: string;
  readonly reason: DisplacementReason;
  readonly byDeviceName: string | null;
  /** Open connections and jobs left running (the modal says they keep running). */
  readonly openConnections: number;
  readonly runningJobs: number;
  /** The final publish succeeded; false: changes stay in W and publish at the next unlock. */
  readonly changesSaved: boolean;
  readonly fileName: string | null;
  /** update_required: the minimum version (S10). */
  readonly minVersion: string | null;
  /** not_owner: this account released the vault earlier (S8b). */
  readonly released: boolean;
  /** device_cap: account_max_active_devices as last confirmed (S2), else null. */
  readonly deviceCap: number | null;
}

/** `vault:session-conflict` (6.8 "Reachable again"): [Use here instead] [Lock here], soft lock at answerByMs. */
export interface SessionConflictEvent {
  readonly lineageId: string;
  readonly holders: readonly Holder[];
  readonly answerByMs: number;
  /** 'device_cap': the account's device cap is full (plan enforcement S3); holders[0] would lock. */
  readonly cause: 'vault_limit' | 'device_cap';
  readonly deviceCap: number | null;
}

export interface SessionEventMap {
  'vault:session-displacing': SessionDisplacingEvent;
  'vault:session-displaced': SessionDisplacedEvent;
  'vault:session-conflict': SessionConflictEvent;
}

export type SessionEmitter = RendererEmitter<SessionEventMap>;

// ---------- Bundle ----------

/** Per-launch facts the session layer needs (computed once at app start). */
export interface SessionConfig {
  readonly syncRoot: string;
  /** {syncRoot}/m-<hw8>. */
  readonly machineDir: string;
  /** The app's data folder (3.2 shared-versus-private decision). */
  readonly dataDir: string;
  /** device.json device_uuid (also the server device_id). */
  readonly deviceUuid: string;
  /** Per launch, memory only (3.1). */
  readonly sessionNonce: string;
}

export interface SessionHost extends SyncHost {
  readonly rpc: RpcCaller;
  readonly realtime: RealtimeHost;
  readonly power: PowerHost;
  readonly activity: ActivityHost;
  readonly busy: BusyHost;
  readonly tierCache: TierCacheHost;
  readonly access: VaultAccessHost;
  readonly sessionEvents: SessionEmitter;
}
