/**
 * Host interfaces of the sync engine, file IO and replica layers (docs/MULTI_DEVICE_SYNC.md
 * 5.x, 6.2, 7.4, 11.1). Everything that touches Electron, the network, the clock, timers or
 * the shared folder reaches these modules through the interfaces below, so the layer runs in
 * vitest without Electron. host-node.ts provides the Node adapters (fs, clock, timers, random,
 * console logger); the integration workflow provides the Electron ones (working copy through
 * ConduitVault, renderer events, shell, settings facts). Types and constants only.
 */

import type Database from 'better-sqlite3';
import type { SyncEmitter } from './host-events.js';
import type { AppDot, RowKey, SyncState } from './types.js';

// ---------- Time ----------

export interface Clock {
  /** Wall-clock milliseconds (Date.now in production). */
  now(): number;
}

export interface TimerHandle {
  cancel(): void;
}

/** Timers go through the host so FakeClock can drive every schedule in tests. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  setInterval(fn: () => void, ms: number): TimerHandle;
  /** Resolves after `ms` on this host's clock. */
  sleep(ms: number): Promise<void>;
}

// ---------- Randomness and key derivation ----------

export interface Random {
  bytes(n: number): Buffer;
  /** Lowercase RFC 4122 v4. */
  uuid(): string;
}

/** PBKDF2 of the vault (vault/crypto.ts deriveKey, 600k iterations). Injected so tests stay fast. */
export interface Kdf {
  deriveKey(password: string, saltB64: string): Buffer;
}

// ---------- Logging ----------

export const SYNC_LOG_PREFIX = '[sync]';
export const SESSION_LOG_PREFIX = '[vault-session]';

/** Never pass secrets, plaintext or vault content in messages or meta. */
export type LogMeta = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Every message starts with SYNC_LOG_PREFIX or SESSION_LOG_PREFIX. */
export interface SyncLogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

// ---------- File system (shared folder and lineage folder) ----------

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  /** Inode or file id as decimal text (bigint stat, exact on Windows); compared with !==. */
  readonly ino: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Only meaningful from lstat(). */
  readonly isSymbolicLink: boolean;
  /** Permission bits (mode & 0o7777); absent from fakes that do not model them. */
  readonly mode?: number;
}

export type WatchEventType = 'rename' | 'change';

export interface WatchHandle {
  close(): void;
}

/**
 * Asynchronous file access. Failures reject with a Node-style error carrying `code`
 * (EPERM, EBUSY, ENOENT, ENOSPC, EACCES, EIO, ETIMEDOUT, ...); paths.isErrno() tests it.
 * Fault-injection wrappers (host-fakes FaultyFs) rely on every call going through here.
 */
export interface SyncFs {
  readFile(p: string): Promise<Buffer>;
  /** Plain write, no fsync. */
  writeFile(p: string, data: Uint8Array | string): Promise<void>;
  /**
   * Write then fsync the file (publish temps, files that must survive a crash). A new file is
   * owner-only unless `mode` is given; `mode` is also applied to an existing file (POSIX only).
   */
  writeFileDurable(p: string, data: Uint8Array | string, mode?: number): Promise<void>;
  /** null only for ENOENT and ENOTDIR; other errors reject (an unreachable share is not "missing"). */
  stat(p: string): Promise<FileStat | null>;
  lstat(p: string): Promise<FileStat | null>;
  realpath(p: string): Promise<string>;
  /** Entry names (not paths). Rejects when the folder is missing. */
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** Removes a file or folder; missing is fine when force is true. */
  rm(p: string, opts: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
  /** Recursive and idempotent. */
  mkdir(p: string): Promise<void>;
  utimes(p: string, atimeMs: number, mtimeMs: number): Promise<void>;
  /** Best effort: never rejects where directory fsync is unsupported (Windows, some shares). */
  fsyncDir(dir: string): Promise<void>;
  /** Directory watch (fs.watch). Errors after start arrive through onError, never thrown. */
  watchDir(
    dir: string,
    onEvent: (type: WatchEventType, fileName: string | null) => void,
    onError: (err: Error) => void,
  ): WatchHandle;
}

// ---------- Working copy W (shared with ConduitVault) ----------

export type JournalMode = 'wal' | 'delete';

export interface WorkingCopyOpenInput {
  readonly path: string;
  /** Key the unlock policy accepted (4.8). ConduitVault is unlocked with it; no password check. */
  readonly key: Buffer;
  /** 'delete' when syncRoot is on a network path (3.2). */
  readonly journalMode: JournalMode;
  /** true: the file must not exist; ConduitDatabase creates a fresh schema-10 file. */
  readonly create: boolean;
}

/**
 * Opens W through the app's ConduitVault/ConduitDatabase (migrations and CREATE_SCHEMA run on
 * that connection, busy_timeout and foreign_keys as today) and returns W's ONLY connection.
 * The sync layer and ConduitVault share it; nobody opens a second connection to W, so a
 * better-sqlite3 transaction on it is atomic with respect to every mutator.
 */
export interface WorkingCopyHost {
  open(input: WorkingCopyOpenInput): WorkingCopyHandle;
}

export interface WorkingCopyHandle {
  /** W's connection. The sync layer never closes it; close() does. */
  readonly db: Database.Database;
  /** ConduitVault must use `key` from now on (W moved to another key epoch, 4.8). */
  setKey(key: Buffer): void;
  /** Installs (or removes with null) the hooks ConduitVault calls around each mutator. */
  setHooks(hooks: VaultSyncHooks | null): void;
  /**
   * A merge, restore or resolution changed content rows of W. The integration refreshes
   * ConduitVault caches and emits `vault:entries-refreshed` to the renderer.
   */
  contentChanged(rows: readonly RowKey[]): void;
  /** ConduitVault.lock(): clears the key and closes the connection. */
  close(): void;
}

/** What one ConduitVault mutator touched (deleted rows included). */
export interface VaultMutationInfo {
  readonly rows: readonly RowKey[];
  /**
   * 4.2 step 5: editor saves, explicit deletes and "Keep" choices are interactive (replace
   * every sibling); MCP, import, autofill-selector saves and rollback are not.
   */
  readonly interactive: boolean;
}

/** Implemented by replica.ts; called by ConduitVault (integration workflow). */
export interface VaultSyncHooks {
  /**
   * Inside the mutator's SQLite transaction, after its writes: captures `rows`, saves the
   * sync tables (a savepoint of that transaction) and bumps W.gen. Throwing aborts the
   * mutation, so a capture failure never leaves content and sync tables out of step.
   */
  captureInTransaction(m: VaultMutationInfo): void;
  /** After the mutator's transaction committed: arms the local-edit trigger (2 s idle, 10 s max). */
  afterCommit(m: VaultMutationInfo): void;
  /** Before a write that bypasses the hooks (raw getDatabase users, vault_meta writes). */
  requestFullPass(reason: string): void;
}

// ---------- App facts and providers ----------

export type DevicePlatform = 'macos' | 'windows' | 'linux';

export interface DeviceInfo {
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly appVersion: string;
}

export interface DeviceInfoProvider {
  current(): DeviceInfo;
}

export interface AccountProvider {
  /** Supabase user id when signed in, else null (signed out or local mode). */
  userId(): string | null;
}

export interface PathClassifier {
  /** network-lock.ts isNetworkPath (extended per 5.4 in the integration). */
  isNetworkPath(p: string): boolean;
  /** Decides path flavor, case folding and Windows-only behavior. */
  readonly platform: NodeJS.Platform;
}

export interface ShellHost {
  /** Electron shell.trashItem: [Move to Trash] only, always after a user click. */
  trashItem(p: string): Promise<void>;
}

export interface AppFacts {
  /** settings.json lists this vault (last_vault_path or recent_vaults), compared by realpath. */
  settingsListsVault(realpath: string): boolean;
  /** First launch of this build on this computer (5.5 upgrade wording); null when unknown. */
  thisBuildFirstLaunchMs(): number | null;
}

export interface FeatureFlags {
  /** tiers.features.personal_sync === 'paused' (8.1 kill switch): no merge, no publish. */
  personalSyncPaused(): boolean;
}

// ---------- Renderer events (host-events.ts) ----------

export * from './host-events.js';

// ---------- Bridge to the device-session layer ----------

export type SessionStatus = 'active' | 'released' | 'expired' | 'displaced';

/** One row of vault_sessions_for (9.4), parsed by vault-session/session-client.ts. */
export interface SessionRowView {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly fileName: string | null;
  readonly fileId: string | null;
  readonly location: string | null;
  readonly status: SessionStatus;
  readonly lastActiveMs: number | null;
  /**
   * The row's last heartbeat (every heartbeat writes the flags; last_active_at moves only while
   * that device is in use). Null from a server older than 20260927234038, which omits it.
   */
  readonly heartbeatAtMs: number | null;
  readonly busySessions: number;
  readonly busyJobs: number;
  /** flags.side_files === 'present'. */
  readonly sideFilesFlag: boolean;
  /** The single written_vv entry {"<dev>": [ms, c]}, or null. */
  readonly marker: AppDot | null;
  readonly writtenAtMs: number | null;
  readonly pendingChanges: boolean;
  readonly abandoned: boolean;
}

/**
 * What the engine needs from the session layer; implemented by vault-session/session-runtime.ts
 * (a null implementation when signed out or for private vaults). Methods must return quickly
 * and must never call back into the engine synchronously (schedule work instead): the engine
 * calls them from inside a cycle.
 */
export interface SessionSignals {
  /** Displaced and soft-locked (6.6 step 4): no cycles at all, not even reads. */
  softLocked(): boolean;
  /** 4.3 rule 2 / 5.5: a session row of this lineage reported side files within 2 hours. */
  serverSideFilesFlagRecent(nowMs: number): boolean;
  /** Rows from the last acquire or heartbeat (divergence, copy class 1, stale waits). */
  sessions(): readonly SessionRowView[];
  /** Presence `session_open` for the next presence write (false during the lock publish). */
  sessionOpen(): boolean;
  /** After every committed merge (owner claims 6.7). */
  afterMerge(state: SyncState): void;
  /** After every successful publish: the marker to report as written_vv (6.11). */
  published(marker: AppDot): void;
  /** After every read of S that produced a state (stale-wait coverage). */
  sharedRead(state: SyncState): void;
  /** Side files next to S appeared or went away (heartbeat flags). */
  sideFilesChanged(present: boolean): void;
}

// ---------- Bundle ----------

export interface SyncHost {
  readonly clock: Clock;
  readonly timers: Timers;
  readonly random: Random;
  readonly kdf: Kdf;
  readonly logger: SyncLogger;
  readonly fs: SyncFs;
  readonly events: SyncEmitter;
  readonly paths: PathClassifier;
  readonly shell: ShellHost;
  readonly flags: FeatureFlags;
  readonly device: DeviceInfoProvider;
  readonly account: AccountProvider;
  readonly app: AppFacts;
  readonly workingCopy: WorkingCopyHost;
}
