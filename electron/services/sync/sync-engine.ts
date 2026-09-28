/**
 * The sync engine of one open shared vault (spec 5.6, 5.7, 5.11, 6.4, 6.6 step 2): single-flight
 * cycles, triggers (local edit 2 s idle / 10 s max, shared-file change, unlock, focus,
 * "Sync now", 60 s safety poll, session hints, verify checks at +15/+60 s), error back-off
 * (5 s doubling to 10 min), publish verification and regression back-off, the final cycle on
 * lock, quit and displacement with caps, copy scans, and the user actions that must run in the
 * engine's lane (side-file confirmation, held changes, password flows, locate, export).
 * The cycle body is sync-cycle.ts; S to S1 is sync-absorb.ts; verification is sync-verify.ts;
 * password flows are sync-epoch.ts. The loop itself is sync-engine-runner.ts.
 */

import path from 'node:path';
import { CandidateQueue } from './candidate-queue.js';
import { SideFiles, type ConfirmOutcome } from './side-files.js';
import { CopyScanner, type CopyScanResult } from './copy-scanner.js';
import { DivergenceTracker } from './divergence.js';
import { FileBindingTracker, fileHintOf, newBinding, type ForkResult } from './file-binding.js';
import { SharedFileWatcher } from './file-watch.js';
import { Notices } from './notices.js';
import { sealLocalCopies } from './password-local-copies.js';
import type { CommitOutcome, ReplicaPort } from './replica.js';
import { createSharedFile, type SharedSnapshot } from './shared-file.js';
import { SnapshotStore } from './snapshots.js';
import { SyncStatusModel } from './sync-status.js';
import type {
  CycleOutcome,
  FinalKind,
  FinalOutcome,
  RunOptions,
  SyncEngineDeps,
  SyncEngineSeams,
  SyncTrigger,
} from './sync-engine-types.js';
import { EngineRunner } from './sync-engine-runner.js';
import { publishDirect, type DirectPublishInput } from './sync-engine-publish.js';
import { confirmSideFilesNow } from './sync-engine-watch.js';
import {
  adoptLegacyChangeAction,
  applyHeldChanges,
  enterNewPasswordAction,
  exportWorkingCopy,
  forkFile,
  forkWorkingCopy,
  keepHeldVersions,
  queueFileCandidate,
  resolveConcurrentAction,
  sha256OfFile,
} from './sync-engine-actions.js';
import type { SessionSignals, SyncHost } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { SideFileTuple, SyncState, UnlockDecision } from './types.js';

export * from './sync-engine-constants.js';
export * from './sync-engine-types.js';

/** Label of the 5.5 [Review unsaved changes first] candidate. */
export const WAL_CANDIDATE_LABEL = 'Unsaved changes found next to the vault file';

type PublishTarget = Pick<DirectPublishInput, 'targetPath' | 'fileId' | 'fileHint'>;

export class SyncEngine {
  private readonly runner: EngineRunner;

  constructor(
    private readonly deps: SyncEngineDeps,
    seams: SyncEngineSeams = {},
  ) {
    this.runner = new EngineRunner(deps, seams);
  }

  /** Starts the watcher, safety poll, copy-scan timer, temp and snapshot cleanup; listens to replica commits. */
  start(): void {
    this.runner.start();
  }

  /** Stops timers and the watcher; waits for the in-flight cycle to settle (it aborts at its next await). */
  stop(): Promise<void> {
    return this.runner.stop();
  }

  /** Schedules a cycle per the trigger's rule (local edits are debounced; others run at once). */
  trigger(t: SyncTrigger): void {
    this.runner.trigger(t);
  }

  /**
   * Single flight: when a cycle runs, callers get a promise for ONE follow-up cycle that starts
   * after it (coalesced), so a change seen mid-cycle is never lost.
   */
  runCycle(reason: SyncTrigger, opts?: RunOptions): Promise<CycleOutcome> {
    return this.runner.runCycle(reason, opts);
  }

  /** "Sync now": clears back-off, then runCycle('sync-now'). */
  syncNow(): Promise<CycleOutcome> {
    return this.runner.syncNow();
  }

  /**
   * 5.6 / 6.4 / 6.6: sets pending_publish, runs one cycle capped at FINAL_CYCLE_CAP_MS
   * (DISPLACED_FINAL_CYCLE_CAP_MS when displaced), clears pending_publish only when S covers
   * W afterwards. Presence session_open comes from session.sessionOpen() (false while locking).
   */
  finalCycle(kind: FinalKind): Promise<FinalOutcome> {
    return this.runner.finalCycle(kind);
  }

  /** Runs `fn` in the engine's lane (no cycle interleaves). */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runner.exclusive(fn);
  }

  /** Resolves when no cycle or action is queued or running (tests, IPC "sync now" waits). */
  whenIdle(): Promise<void> {
    return this.runner.whenIdle();
  }

  /** 5.8 scan in the lane; class 3 merged, class 4 and same-device copies become prompts. */
  scanCopies(): Promise<CopyScanResult> {
    return this.runner.scanCopies();
  }

  /** 5.5 [Conduit is closed on my other computers] / [Continue]; then a cycle publishes. */
  confirmSideFiles(shown: readonly SideFileTuple[], walReviewed: boolean): Promise<ConfirmOutcome> {
    return this.act(
      () => confirmSideFilesNow(this.deps, shown, walReviewed),
      (res) => res.kind === 'confirmed',
    );
  }

  /** 5.5 [Review unsaved changes first]: sideFiles.stageWalCopy, queued as a 'leftover-wal' candidate; returns its id. */
  reviewSideFileWal(): Promise<string> {
    const { sideFiles, candidates, status } = this.deps;
    return this.runner.exclusive(async () => {
      const staged = await sideFiles.stageWalCopy();
      const c = await candidates.addFile({ path: staged, source: 'leftover-wal', label: WAL_CANDIDATE_LABEL, staleByNature: false });
      status.setPrompt({ kind: 'candidate', id: `candidate:${c.id}`, candidateId: c.id, label: c.label });
      return c.id;
    });
  }

  /** 7.3 held legacy changes [Apply these changes]: capture-legacy.applyHeld, commit, clear heldLegacy. */
  applyHeld(): Promise<CommitOutcome | null> {
    return this.act(
      () => {
        const out = applyHeldChanges(this.deps);
        this.deps.status.clearPrompt('held-legacy');
        return out;
      },
      (out) => out !== null,
    );
  }

  /** 7.3 [Keep my versions]: interactive re-assertion of the current values, clear heldLegacy, publish. */
  keepHeld(): Promise<CommitOutcome | null> {
    return this.act(
      () => {
        const out = keepHeldVersions(this.deps);
        this.deps.status.clearPrompt('held-legacy');
        return out;
      },
      () => true,
    );
  }

  /**
   * 4.8 Change Password on this device: one W transaction with a new epoch (replica.changePassword),
   * then the private copies beside W stop opening with the old password (password-local-copies.ts),
   * then a cycle publishes. Throws only when the password change itself failed.
   */
  changePassword(currentPassword: string, newPassword: string, eraseRecentlyDeleted: boolean): Promise<void> {
    return this.act(
      async () => {
        this.deps.replica.changePassword(currentPassword, newPassword, eraseRecentlyDeleted);
        await sealLocalCopies(this.deps);
      },
      () => true,
    );
  }

  /** 4.8 S newer: "Enter the new password to keep syncing" (sync-epoch.enterNewPassword on the last S). */
  enterNewPassword(password: string): Promise<UnlockDecision> {
    return this.act(
      () => enterNewPasswordAction(this.deps, this.runner.memory, password),
      (decision) => decision.ok,
    );
  }

  /**
   * 4.8 legacy password change found in S (synced, or pre-sync before this device's first
   * publish, 12 row 64). `previousPassword` null: W's unreadable secrets become undecryptable siblings.
   */
  adoptLegacyPasswordChange(newPassword: string, previousPassword: string | null): Promise<CommitOutcome> {
    return this.act(
      () => adoptLegacyChangeAction(this.deps, this.runner.memory, newPassword, previousPassword),
      () => true,
    );
  }

  /** 4.8 concurrent changes: the other password once, then the winner. */
  resolveConcurrentEpoch(otherPassword: string, winnerEpochId: string): Promise<CommitOutcome> {
    return this.act(
      () => resolveConcurrentAction(this.deps, this.runner.memory, otherPassword, winnerEpochId),
      () => true,
    );
  }

  /** 5.9 [Locate...]: file-binding.locate, then a cycle. */
  locate(filePath: string): Promise<boolean> {
    return this.act(
      async () => {
        const res = await this.deps.binding.locate(filePath);
        if (res.kind !== 'bound') {
          this.deps.host.logger.info(`${SYNC_LOG_PREFIX} located file refused`, { outcome: res.kind });
          return false;
        }
        this.boundAgain(res.binding.sharedPath);
        return true;
      },
      (ok) => ok,
    );
  }

  /** 5.9 [Save a new copy here]: publish W to `path` (expectedSha256 null), rebind with a new file_id. */
  saveNewCopyHere(filePath: string): Promise<boolean> {
    const { host, binding } = this.deps;
    return this.act(
      async () => {
        const nb = await newBinding(filePath, host);
        const hint = fileHintOf(nb, host.paths.platform, host.paths.isNetworkPath);
        const sha256 = await this.publishTo({ targetPath: filePath, fileId: nb.fileId, fileHint: hint });
        if (sha256 === null) return false;
        const res = await binding.locate(filePath);
        if (res.kind !== 'bound') {
          host.logger.error(`${SYNC_LOG_PREFIX} the new copy could not be bound`, { outcome: res.kind });
          return false;
        }
        this.boundAgain(res.binding.sharedPath);
        await this.runner.acknowledgePublished(res.binding.sharedPath, sha256);
        return true;
      },
      (ok) => ok,
    );
  }

  /** First publish of a new vault (6.3 create): S must not exist (expectedSha256 null). */
  publishInitial(): Promise<boolean> {
    const { binding } = this.deps;
    return this.runner.exclusive(async () => {
      const b = binding.binding();
      const sha256 = await this.publishTo({ targetPath: b.sharedPath, fileId: b.fileId, fileHint: binding.fileHint() });
      if (sha256 !== null) await this.runner.acknowledgePublished(b.sharedPath, sha256);
      return sha256 !== null;
    });
  }

  /**
   * 5.8 same-device copy prompt: 'separate' forks `copyPath` into `targetPath` (new lineage);
   * 'merge' queues `copyPath` as a candidate and rebinds to the original path; 'ignore' keeps
   * the current binding (its own file_id). Clears the prompt.
   */
  resolveSameDeviceCopy(choice: 'separate' | 'merge' | 'ignore', copyPath: string, targetPath: string | null): Promise<void> {
    return this.act(
      async () => {
        if (choice === 'separate') await this.forkCopy(copyPath, targetPath);
        if (choice === 'merge') await this.mergeCopy(copyPath);
        this.deps.status.clearPrompt(`same-device-copy:${copyPath}`);
      },
      () => choice === 'merge',
    );
  }

  /** 5.8 [Keep separate] / 5.9 [Use as a separate vault]: fork W (VACUUM INTO) to `targetPath`; the IPC then opens it. */
  makeSeparateVault(targetPath: string): Promise<ForkResult> {
    return this.runner.exclusive(() => forkWorkingCopy(this.deps, targetPath));
  }

  /** 5.11 [Export unsynced changes]: VACUUM INTO exports/<name> (unsynced changes).conduit; returns its path. */
  exportUnsynced(): Promise<string> {
    return this.runner.exclusive(() => exportWorkingCopy(this.deps));
  }

  /** The last S read in this session (password flows and candidate staging use it). */
  lastShared(): SharedSnapshot | null {
    return this.runner.memory.lastShared;
  }

  /** State of the last synced S read (stale-wait coverage at start), or null. */
  lastSharedState(): SyncState | null {
    return this.runner.lastSharedState();
  }

  /** The wired modules (IPC handlers and the session runtime reach status, scanner, candidates... here). */
  parts(): SyncEngineDeps {
    return this.deps;
  }

  /** A user action in the lane, then (outside the lane, so it cannot deadlock) a cycle when asked. */
  private async act<T>(fn: () => Promise<T> | T, followUp: (result: T) => boolean): Promise<T> {
    let result: T;
    try {
      result = await this.runner.exclusive(fn);
    } catch (err) {
      const e = err as { name?: string; code?: unknown };
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} user action failed`, {
        name: e?.name ?? 'Error',
        code: typeof e?.code === 'string' ? e.code : null,
      });
      throw err;
    }
    if (followUp(result)) this.runner.fire('sync-now');
    return result;
  }

  private boundAgain(sharedPath: string): void {
    this.deps.status.clearPrompt('file-missing');
    this.deps.status.clearPrompt('foreign-other-vault');
    this.runner.status({ fileMissing: false, fileName: path.basename(sharedPath) });
  }

  /** Direct publish to a path that must not exist yet; recorded like a cycle publish. Returns the SHA-256 or null. */
  private async publishTo(target: PublishTarget): Promise<string | null> {
    const { session, notices } = this.deps;
    const res = await publishDirect(
      { ...this.deps, ownWrites: (fn) => this.runner.ownWrites(fn) },
      { ...target, expectedSha256: null, observedMtimeMs: null, sessionOpen: session.sessionOpen(), sessionSinceMs: this.runner.openedAtMs },
    );
    if (res.kind === 'failed') notices.toast('publish-failed', { code: res.code, fileName: path.basename(target.targetPath) });
    if (res.kind !== 'published') return null;
    this.runner.recordDirectPublish(res);
    return res.sha256;
  }

  private async forkCopy(copyPath: string, targetPath: string | null): Promise<void> {
    if (targetPath === null) throw new Error(`${SYNC_LOG_PREFIX} a separate vault needs a target path`);
    await forkFile(this.deps, copyPath, targetPath);
    this.deps.scanner.ignore(await sha256OfFile(this.deps, copyPath));
  }

  private async mergeCopy(copyPath: string): Promise<void> {
    await queueFileCandidate(this.deps, copyPath);
    const res = await this.deps.binding.locate(copyPath);
    if (res.kind === 'bound') this.boundAgain(res.binding.sharedPath);
    else this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not bind back to the original file`, { outcome: res.kind });
  }
}

export interface AssembleInput {
  readonly host: SyncHost;
  readonly replica: ReplicaPort;
  readonly session: SessionSignals;
  /** Realpath of S at open (side-file upgrade wording). */
  readonly realpath: string;
}

/**
 * Wires the real modules (shared-file, file-watch, side-files, file-binding, copy-scanner,
 * candidate-queue, divergence, snapshots, sync-status, notices) around a replica whose
 * local.json already holds the binding. Does not start the engine.
 */
export function assembleSyncEngine(input: AssembleInput): SyncEngine {
  const { host, replica, session, realpath } = input;
  const shared = createSharedFile(host);
  const notices = new Notices({ replica, host });
  const status = new SyncStatusModel(replica.lineageId, host);
  const binding = new FileBindingTracker({ replica, shared, host });
  const sideFiles = new SideFiles(binding.sharedPath(), { replica, host, realpath });
  const candidates = new CandidateQueue({ replica, shared, notices, host });
  const snapshots = new SnapshotStore(replica.paths.snapshots, host);
  const scanner = new CopyScanner({ replica, binding, shared, candidates, notices, session, host, snapshots });
  return new SyncEngine({
    host,
    replica,
    shared,
    binding,
    sideFiles,
    scanner,
    candidates,
    divergence: new DivergenceTracker(),
    snapshots,
    status,
    notices,
    session,
    createWatcher: (sharedPath, listener) => new SharedFileWatcher(sharedPath, host, listener),
  });
}

/** Session signals for signed-out devices and tests: nothing blocked, no rows, session open. */
export function nullSessionSignals(): SessionSignals {
  return {
    softLocked: () => false,
    serverSideFilesFlagRecent: () => false,
    sessions: () => [],
    sessionOpen: () => true,
    afterMerge: () => undefined,
    published: () => undefined,
    sharedRead: () => undefined,
    sideFilesChanged: () => undefined,
  };
}
