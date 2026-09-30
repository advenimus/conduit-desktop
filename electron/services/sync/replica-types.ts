/**
 * Constants and shapes of replica.ts (spec 3.1, 3.2, 4.1, 5.1). Import through replica.ts.
 */

import type Database from 'better-sqlite3';
import type { HighWater, HighWaterVerdict } from './identity.js';
import type { LineagePaths } from './paths.js';
import type { IncarnationRegistry } from './replica-incarnation.js';
import type { JournalMode, SyncHost, VaultMutationInfo, VaultSyncHooks, WorkingCopyHandle } from './host.js';
import type {
  AppDot,
  CaptureResult,
  ContentSnapshot,
  Dev,
  FileBinding,
  Hlc,
  ImplicitProvider,
  KeyRing,
  LocalJson,
  LocalNotice,
  LocalWrite,
  RowCache,
  RowKey,
  StructuralConflict,
  SyncContext,
  SyncState,
} from './types.js';

/** 3.2: genesis.conduit is kept 180 days as the G2 baseline. */
export const GENESIS_BASELINE_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
/** Bytes of a new vault salt (same as vault/crypto.ts generateSalt). */
export const NEW_SALT_BYTES = 32;

/** How W is seeded when this device has no W for the lineage yet. */
export type ReplicaSeed =
  /** W must already exist. */
  | { readonly kind: 'existing' }
  /** G1: S is pre-sync; these are its exact bytes (genesis_id = SHA-256, kept as genesis.conduit). */
  | { readonly kind: 'genesis'; readonly sharedBytes: Buffer }
  /** S already has sync tables (another device migrated): W = S's bytes, absorbed against its own tables. */
  | {
      readonly kind: 'adopt';
      readonly sharedBytes: Buffer;
      readonly sharedSha256: string;
      readonly sharedMtimeMs: number;
      /** 4.3 rule 2 at open: side files next to S, or the server flag is recent. */
      readonly holdLegacy: boolean;
    }
  /** vault_create: random lineage and genesis, E0 from the given salt and verification. */
  | { readonly kind: 'new-vault'; readonly salt: string; readonly verification: string; readonly vaultId: string };

export interface ReplicaOpenInput {
  readonly syncRoot: string;
  /** {syncRoot}/m-<hw8> (identity.loadOrCreateDevice). */
  readonly machineDir: string;
  readonly deviceUuid: string;
  readonly lineageId: string;
  /**
   * Key accepted by the unlock policy (4.8). It may belong to an epoch newer than W's
   * ('s-newer', 'needs-wrap', 'legacy-change'); then epochAligned() is false until
   * sync-epoch.adoptEpochAtOpen() ran, and the hooks refuse to capture.
   */
  readonly key: Buffer;
  readonly seed: ReplicaSeed;
  /** Binding to store in local.json; null keeps the stored one (null for a bound W opened offline). */
  readonly binding: FileBinding | null;
}

/** One lineage's per-process identity (4.1): kept across lock/unlock within one app launch. */
export interface LineageIncarnation {
  readonly incarnation: string;
  readonly dev: Dev;
  /** The process's high-water mark for this lineage (identity.HighWater). */
  readonly highWater: HighWater;
}

export interface ReplicaDeps {
  readonly host: Pick<SyncHost, 'clock' | 'random' | 'kdf' | 'logger' | 'fs' | 'paths' | 'workingCopy'>;
  readonly incarnations: IncarnationRegistry;
  /** Tests: reload W after every commit and assert digest equality (like core-e2e-harness commit()). */
  readonly verifyCommits?: boolean;
}

/** W as last committed. `cache` is sync_row; content is always re-read from W's connection. */
export interface WorkingSnapshot {
  readonly state: SyncState;
  readonly cache: RowCache;
  readonly fileId: string | null;
}

export interface CommitOptions {
  /** Written to sync_state.file_id (publish path). Omitted: unchanged. */
  readonly fileId?: string | null;
  /** capture-local scope when committing a per-operation capture (materialize capturedRows). */
  readonly capturedRows?: readonly RowKey[];
  /** Content to materialize over (default loadContent(db)); must hold every row of capturedRows. */
  readonly content?: ContentSnapshot;
  /** Call handle.contentChanged (default true); the capture hook defers it to afterCommit. */
  readonly notify?: boolean;
}

export interface CommitOutcome {
  readonly state: SyncState;
  /** Content rows the commit wrote or deleted (handle.contentChanged was called with them). */
  readonly changedRows: readonly RowKey[];
  readonly structural: readonly StructuralConflict[];
  /** W.gen after the commit. */
  readonly generation: number;
}

export interface ApplyOptions {
  readonly interactive: boolean;
  /** Rule R re-assertions (default true); false for `_sync` writes and the epoch register. */
  readonly ruleR?: boolean;
  /** Written to sync_state.file_id in the same commit (the publish marker write, 5.3 step 1). */
  readonly fileId?: string | null;
}

export type IncarnationReason = 'launch' | 'high-water' | 'dev-collision';

export interface ReplicaOpenResult {
  readonly replica: ReplicaPort;
  /** W did not exist before this open. */
  readonly created: boolean;
  readonly seeded: ReplicaSeed['kind'];
  /** Notices of the seed (genesis undecryptable secrets, adopt legacy drops) for notices.addFromCapture. */
  readonly notices: readonly LocalNotice[];
  /** local.json was corrupt and parked; it was rebuilt from W. */
  readonly localRebuilt: boolean;
}

export interface PendingSummary {
  readonly lineageId: string;
  readonly sharedPath: string | null;
  readonly pendingPublish: boolean;
}

/** What the engine, the session layer and the IPC layer use. */
export interface ReplicaPort {
  readonly lineageId: string;
  readonly deviceUuid: string;
  readonly paths: LineagePaths;
  readonly journalMode: JournalMode;
  readonly handle: WorkingCopyHandle;
  /** W's shared connection (VACUUM INTO, snapshots). Never close it directly. */
  database(): Database.Database;
  dev(): Dev;
  incarnation(): string;
  /** Current SyncContext (dev, incarnation, ring, clock, randomness). New object after ring/dev changes. */
  context(): SyncContext;
  ring(): KeyRing;
  /** makeImplicitProvider(ring().current.kSync). */
  implicit(): ImplicitProvider;
  current(): WorkingSnapshot;
  state(): SyncState;
  /** In-memory W.gen (5.6), bumped by every commit and every captured mutation. */
  generation(): number;
  /** Structural conflicts of the last materialization (ConflictContext). */
  structural(): readonly StructuralConflict[];
  /** W's current epoch is the ring's current epoch. */
  epochAligned(): boolean;
  /** HLC tick for one operation. The high-water mark records dots only once they are committed. */
  tick(): AppDot;
  /** HLC receive after a merge (hlc.maxReceivable with this install's devs). */
  receive(merged: SyncState): void;
  /** 4.1 at unlock and before each capture: starts a new incarnation when W was replaced. */
  highWaterCheck(): HighWaterVerdict;
  /** New incarnation (new dev), recorded in local.json; returns the dev change. */
  startNewIncarnation(reason: IncarnationReason): { readonly oldDev: Dev; readonly newDev: Dev };
  /** 4.2 step 6 full pass with one non-interactive dot; commits when anything changed. */
  fullPass(): CaptureResult;
  /** Explicit writes (resolutions, restores, presence, claims) under one dot, after capturing writes that skipped the hooks; commits. */
  applyWrites(writes: readonly LocalWrite[], opts: ApplyOptions): CaptureResult;
  /**
   * Materialize `next` over W's current content, save (diffed), bump gen, notify content
   * changes. `next` must include every write that skipped the hooks: compute it from state()
   * right after captureSkippedWrites(), with no await in between.
   */
  commit(next: SyncState, opts?: CommitOptions): CommitOutcome;
  /**
   * commit() only if generation() === expected (checked inside the write transaction); null
   * otherwise. Writes that skipped the hooks are captured first; a capture moves W.gen (null).
   */
  commitIfGeneration(next: SyncState, expected: number, opts?: CommitOptions): CommitOutcome | null;
  /** Captures writes that skipped the hooks, then fn(W's current state) and commit, in one IMMEDIATE transaction. */
  commitWith(fn: (w: SyncState) => SyncState, opts?: CommitOptions): CommitOutcome;
  /** Replace the ring after an epoch change; also handle.setKey(key). */
  setRing(ring: KeyRing, key: Buffer): void;
  local(): LocalJson;
  /** Read-modify-write of local.json (atomic); returns the written value. */
  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson;
  /** The hooks installed on the handle at open. */
  hooks(): VaultSyncHooks;
  /** Listener for committed local mutations (the engine arms its local-edit trigger). */
  onLocalCommit(listener: (m: VaultMutationInfo) => void): () => void;
  /** Listener for requestFullPass (the engine runs a full pass in its lane). */
  onFullPassRequest(listener: (reason: string) => void): () => void;
  /**
   * New-build password change (4.8, rekey.changePassword): verifies `currentPassword` against
   * the current epoch's salt, new salt from host.random, commits, setRing. Throws
   * Error('Invalid master password') on a wrong current password.
   */
  changePassword(currentPassword: string, newPassword: string, eraseRecentlyDeleted: boolean): void;
  /** Removes the hooks and closes W (handle.close). Idempotent. */
  close(): void;
}

/**
 * 4.2 step 6 before an unconditional commit(): capture writes that skipped the hooks so the
 * caller computes its state from them. A no-op while W is not in the ring's epoch.
 */
export function captureSkippedWrites(replica: Pick<ReplicaPort, 'epochAligned' | 'fullPass'>): void {
  if (replica.epochAligned()) replica.fullPass();
}

/** What replica-open.ts hands the Replica it builds. */
export interface ReplicaInit {
  readonly lineageId: string;
  readonly deviceUuid: string;
  readonly paths: LineagePaths;
  readonly journalMode: JournalMode;
  readonly handle: WorkingCopyHandle;
  readonly deps: ReplicaDeps;
  readonly snapshot: WorkingSnapshot;
  readonly structural: readonly StructuralConflict[];
  readonly ring: KeyRing;
  readonly incarnation: LineageIncarnation;
  readonly clockStart: Hlc;
  readonly local: LocalJson;
}
