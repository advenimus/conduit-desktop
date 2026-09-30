/**
 * Collaborators of openPersonalVault (spec 6.3) as one injectable bag, each defaulting to the
 * real module. Tests replace any subset; the integration workflow passes none. Also the
 * per-open context: host, config, the session client and lease tracker of this open, the
 * memoized PBKDF2 of the typed password, and the private staging folder {syncRoot}/tmp.
 */

import path from 'node:path';
import { locationOf } from '../sync/file-binding.js';
import { buildPresence, readPresence, type PresenceEntry, type PresenceFields } from '../sync/presence.js';
import {
  IncarnationRegistry,
  findBoundLineage,
  hasWorkingCopy,
  openReplica,
  type ReplicaDeps,
  type ReplicaOpenInput,
  type ReplicaOpenResult,
} from '../sync/replica.js';
import {
  classifyStaged,
  readShared,
  type ClassifyExpectation,
  type SharedClass,
  type SharedFileHost,
  type SharedReadOutcome,
  type SharedSnapshot,
} from '../sync/shared-file.js';
import { assembleSyncEngine, type AssembleInput, type SyncEngine } from '../sync/sync-engine.js';
import { adoptEpochAtOpen, type AdoptAtOpenInput, type EpochHost } from '../sync/sync-epoch.js';
import type { CommitOutcome } from '../sync/replica.js';
import type { LocalWrite, PresenceValue, SyncContext, SyncState } from '../sync/types.js';
import { claimWrites, evaluateClaims, unlockClaimAction, type ClaimInputs, type ClaimVerdict } from './claims.js';
import { claimsApply, effectiveLimit, type EffectiveLimit, type LimitInputs } from './effective-limit.js';
import { LeaseTracker } from './lease.js';
import { OwnCopyTickets } from './own-copy-tickets.js';
import { readWorkingStateCopy, type StagingHost } from './open-staging.js';
import { SessionClient, type SessionClientPort } from './session-client.js';
import { PersonalVaultRuntime, type RuntimeDeps } from './session-runtime.js';
import { waitForSyncedFile, type G1WaitInput } from './stale-wait.js';
import type { SessionConfig, SessionHost } from './host.js';
import type { OpenDeps, OpenPersonalVaultInput } from './open-personal-vault.js';

/** Folder under syncRoot for peek copies (6.3 step 2); every staged file is removed at the end of the open. */
export const PEEK_DIR_NAME = 'tmp';

export type G1Outcome = Awaited<ReturnType<typeof waitForSyncedFile>>;

export interface OpenCollaborators {
  readonly readShared: (sharedPath: string, stagingDir: string, host: SharedFileHost) => Promise<SharedReadOutcome>;
  readonly classify: (snapshot: SharedSnapshot, expect: ClassifyExpectation) => SharedClass;
  readonly findBoundLineage: (machineDir: string, realpath: string, deps: ReplicaDeps) => Promise<string | null>;
  readonly hasWorkingCopy: (machineDir: string, lineageId: string, deps: ReplicaDeps) => Promise<boolean>;
  /** W's state through a private copy (W itself is never opened before the password is accepted). */
  readonly readWorkingState: (workingPath: string, stagingDir: string, host: StagingHost) => Promise<SyncState>;
  readonly openReplica: (input: ReplicaOpenInput, deps: ReplicaDeps) => Promise<ReplicaOpenResult>;
  readonly adoptEpochAtOpen: (input: AdoptAtOpenInput, host: EpochHost) => Promise<CommitOutcome>;
  readonly assembleEngine: (input: AssembleInput) => SyncEngine;
  readonly createClient: (host: SessionHost) => SessionClientPort;
  readonly createLease: () => LeaseTracker;
  readonly createRuntime: (deps: RuntimeDeps) => PersonalVaultRuntime;
  readonly waitForSyncedFile: (input: G1WaitInput) => Promise<G1Outcome>;
  readonly effectiveLimit: (input: LimitInputs) => EffectiveLimit;
  readonly claimsApply: (limit: number) => boolean;
  readonly evaluateClaims: (input: ClaimInputs) => ClaimVerdict;
  readonly unlockClaimAction: (verdict: ClaimVerdict) => 'prompt' | 'claim' | 'skip';
  readonly claimWrites: (accountHint: string | null, ctx: SyncContext) => readonly LocalWrite[];
  readonly readPresence: (state: SyncState, deviceUuid: string) => PresenceEntry | null;
  readonly buildPresence: (prev: PresenceValue | null, fields: PresenceFields) => PresenceValue;
  readonly locationOf: (realpath: string, platform: NodeJS.Platform, isNetworkPath: (p: string) => boolean) => string;
}

export const REAL_COLLABORATORS: OpenCollaborators = {
  readShared,
  classify: classifyStaged,
  findBoundLineage,
  hasWorkingCopy,
  readWorkingState: readWorkingStateCopy,
  openReplica,
  adoptEpochAtOpen,
  assembleEngine: assembleSyncEngine,
  createClient: (host) => new SessionClient(host.rpc, host),
  createLease: () => new LeaseTracker(),
  createRuntime: (deps) => new PersonalVaultRuntime(deps),
  waitForSyncedFile,
  effectiveLimit,
  claimsApply,
  evaluateClaims,
  unlockClaimAction,
  claimWrites,
  readPresence,
  buildPresence,
  locationOf,
};

/** Process lifetime, like the registry the app creates at start (3.1 incarnation per launch). */
const DEFAULT_INCARNATIONS = new IncarnationRegistry();
/** Process lifetime; the app passes its own store so lock, sign-out and quit can clear it. */
const DEFAULT_TICKETS = new OwnCopyTickets();

/** Everything one open needs; built once per openPersonalVault call. */
export interface OpenContext {
  readonly input: OpenPersonalVaultInput;
  readonly host: SessionHost;
  readonly config: SessionConfig;
  readonly deps: OpenDeps;
  readonly progress: OpenDeps['progress'];
  readonly c: OpenCollaborators;
  readonly replicaDeps: ReplicaDeps;
  readonly client: SessionClientPort;
  readonly lease: LeaseTracker;
  /** "Make my own copy" keys of not-owner refusals (plan enforcement 4.5). */
  readonly tickets: OwnCopyTickets;
  readonly stagingDir: string;
  /** Absolute path as the user named it (binding shared_path). */
  readonly sharedPath: string;
  readonly fileName: string;
  readonly signedIn: boolean;
  readonly openedAtMs: number;
  /** PBKDF2(password, salt) memoized per salt: each derivation costs about half a second. */
  kdf(password: string, saltB64: string): Buffer;
  /** Staged copies to remove when the open ends. */
  readonly staged: StagedFiles;
}

export class StagedFiles {
  private readonly paths = new Set<string>();

  add(p: string): void {
    this.paths.add(p);
  }

  list(): readonly string[] {
    return [...this.paths];
  }
}

export function makeOpenContext(input: OpenPersonalVaultInput, deps: OpenDeps): OpenContext {
  const c: OpenCollaborators = {
    ...REAL_COLLABORATORS,
    ...deps.collaborators,
    ...(deps.assembleEngine ? { assembleEngine: deps.assembleEngine } : {}),
  };
  const { host, config } = deps;
  const sharedPath = path.resolve(input.path);
  const memo = new Map<string, Buffer>();
  return {
    input,
    host,
    config,
    deps,
    progress: deps.progress,
    c,
    replicaDeps: { host, incarnations: deps.incarnations ?? DEFAULT_INCARNATIONS, verifyCommits: deps.verifyCommits },
    client: c.createClient(host),
    lease: c.createLease(),
    tickets: deps.tickets ?? DEFAULT_TICKETS,
    stagingDir: path.join(config.syncRoot, PEEK_DIR_NAME),
    sharedPath,
    fileName: path.basename(sharedPath),
    signedIn: host.account.userId() !== null,
    openedAtMs: host.clock.now(),
    kdf(password: string, saltB64: string): Buffer {
      const id = `${password.length}:${saltB64}:${password}`;
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      const key = host.kdf.deriveKey(password, saltB64);
      memo.set(id, key);
      return key;
    },
    staged: new StagedFiles(),
  };
}
