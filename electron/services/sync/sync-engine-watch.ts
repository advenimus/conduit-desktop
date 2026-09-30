/**
 * The engine's reactions outside cycles (spec 5.4 watching, 5.5 side files and the daily
 * reminder, 5.3 step 6 and 5.10 start-up cleanup, 4.8 local copies still due after an epoch change, 3.2 network-root warning, 5.8 pending
 * candidates at start): the watcher listener, the side-file prompt, and start-up housekeeping.
 */

import path from 'node:path';
import { SIDE_FILES_REMINDER_MS, type ConfirmOutcome, type SideFilesView } from './side-files.js';
import type { FileWatcherPort, FileWatchListener } from './file-watch.js';
import { cleanupScratch, pruneQuarantine } from './housekeeping-files.js';
import { sealIfPending } from './password-local-copies.js';
import type { SharedSnapshot } from './shared-file.js';
import type { SyncEngineDeps, SyncTrigger } from './sync-engine-types.js';
import type { SideFileTuple } from './types.js';
import { SYNC_LOG_PREFIX } from './host.js';
import { errMeta } from './sync-engine-local.js';

/** 3.2: the network-root warning shows once (per launch, per lineage). */
export const NETWORK_ROOT_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;
export const SIDE_FILES_PROMPT_ID = 'side-files';

export interface WatchHooks {
  readonly deps: SyncEngineDeps;
  fire(t: SyncTrigger): void;
  requestScan(): void;
  alive(): boolean;
  /** A held-open side-file move is due again (5.5). */
  retrySideFiles(): void;
}

/** Prompt while side files are present (reading and merging continue; publishing pauses). */
export function showSideFiles(deps: SyncEngineDeps, view: SideFilesView): void {
  if (view.state !== 'present') {
    deps.status.clearPrompt(SIDE_FILES_PROMPT_ID);
    return;
  }
  deps.status.setPrompt({
    kind: 'side-files',
    id: SIDE_FILES_PROMPT_ID,
    upgradeWording: view.upgradeWording,
    walNonEmpty: view.walNonEmpty,
  });
  if (deps.notices.remindDue('side-files', SIDE_FILES_REMINDER_MS)) {
    deps.notices.toast('side-files-reminder', { fileName: path.basename(deps.binding.sharedPath()) });
  }
}

/** One stat poll's side-file tuples: state, prompt, heartbeat flag, and a cycle when publishing may resume. */
export function observeSideFiles(h: WatchHooks, tuples: readonly SideFileTuple[]): void {
  if (!h.alive()) return;
  const { sideFiles, session, host } = h.deps;
  try {
    const before = sideFiles.view();
    const after = sideFiles.observe(tuples);
    showSideFiles(h.deps, after);
    if (before.holdLegacy !== after.holdLegacy) session.sideFilesChanged(after.holdLegacy);
    if (!before.publishAllowed && after.publishAllowed) h.fire('shared-changed');
    if (after.state === 'present') h.retrySideFiles();
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} side-file observation failed`, errMeta(err));
  }
}

/** sideFiles.confirm with the prompt and the session's hold flag kept in step (run in the lane). */
export async function confirmSideFilesNow(
  deps: SyncEngineDeps,
  shown: readonly SideFileTuple[],
  walReviewed: boolean,
): Promise<ConfirmOutcome> {
  const { sideFiles, session } = deps;
  const before = sideFiles.view();
  const res = await sideFiles.confirm(shown, walReviewed);
  const after = sideFiles.view();
  showSideFiles(deps, after);
  if (before.holdLegacy !== after.holdLegacy) session.sideFilesChanged(after.holdLegacy);
  return res;
}

/** 5.5: a confirmed move that found a side file held open is retried on later polls, one at a time. */
export class SideFileRetrier {
  private queued = false;

  constructor(
    private readonly deps: SyncEngineDeps,
    private readonly inLane: (fn: () => Promise<ConfirmOutcome>) => Promise<ConfirmOutcome>,
    private readonly moved: () => void,
  ) {}

  request(): void {
    const intent = this.deps.sideFiles.pendingRetry();
    if (intent === null || this.queued) return;
    this.queued = true;
    this.inLane(() => confirmSideFilesNow(this.deps, intent.tuples, intent.walReviewed))
      .then(
        (res) => (res.kind === 'confirmed' ? this.moved() : undefined),
        (err: unknown) => this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} retrying the side-file move failed`, errMeta(err)),
      )
      .finally(() => {
        this.queued = false;
      });
  }
}

export function makeWatchListener(h: WatchHooks): FileWatchListener {
  const log = h.deps.host.logger;
  return {
    sharedChanged: (reason) => {
      log.debug(`${SYNC_LOG_PREFIX} shared file changed`, { reason });
      h.fire('shared-changed');
    },
    sideFilesObserved: (tuples) => observeSideFiles(h, tuples),
    directoryChanged: () => h.requestScan(),
    watchError: (err) => log.warn(`${SYNC_LOG_PREFIX} folder watch failed; polling continues`, errMeta(err)),
  };
}

/** 3.2 one-time warning when W runs in DELETE mode on a network root. */
export function noteNetworkRoot(deps: SyncEngineDeps): boolean {
  const networkRoot = deps.replica.journalMode === 'delete';
  if (networkRoot && deps.notices.remindDue('network-root', NETWORK_ROOT_REMINDER_MS)) {
    deps.notices.toast('network-root', { fileName: path.basename(deps.binding.sharedPath()) });
  }
  return networkRoot;
}

async function step(deps: SyncEngineDeps, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} start-up cleanup step failed`, { step: what, ...errMeta(err) });
  }
}

/** Staged copies still in use: the last merged and published S, plus `extra`. */
function stagedInUse(deps: SyncEngineDeps, extra: readonly (string | null)[]): readonly string[] {
  const local = deps.replica.local();
  const all = [local.lastMergedSha256, local.lastPublished?.sha256 ?? null, ...extra];
  return [...new Set(all.filter((s): s is string => s !== null))];
}

/**
 * 5.2: every read of a new S (and every scanned copy) stages a full copy in incoming/, so it is
 * pruned after each cycle and scan, not only at start. Runs in the lane; a failure only logs.
 */
export async function pruneIncoming(deps: SyncEngineDeps, lastShared: SharedSnapshot | null): Promise<void> {
  try {
    await deps.shared.cleanupIncoming(deps.replica.paths.incoming, stagedInUse(deps, [lastShared?.sha256 ?? null]));
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} pruning staged copies failed`, errMeta(err));
  }
}

/** Start-up cleanup; each step is independent and a failure only logs. `keepShas`: staged copies in use. */
export async function housekeeping(deps: SyncEngineDeps, keepShas: readonly string[], alive: () => boolean): Promise<void> {
  const { shared, replica, snapshots, sideFiles, candidates, host, status, binding } = deps;
  const now = host.clock.now();
  const keep = stagedInUse(deps, keepShas);
  const steps: readonly [string, () => Promise<unknown>][] = [
    ['local-copies', () => sealIfPending(deps)],
    ['publish-temps', () => shared.cleanupPublishTemps(path.dirname(binding.sharedPath()), now)],
    ['incoming', () => shared.cleanupIncoming(replica.paths.incoming, keep)],
    ['snapshots', () => snapshots.prune(now)],
    ['side-files', () => sideFiles.cleanup(now)],
    ['tmp', () => cleanupScratch(replica.paths.tmp, now, host)],
    ['quarantine', () => pruneQuarantine(replica.paths.quarantine, now, host)],
    [
      'candidates',
      async () => {
        await candidates.load();
        for (const c of candidates.list()) {
          status.setPrompt({ kind: 'candidate', id: `candidate:${c.id}`, candidateId: c.id, label: c.label });
        }
      },
    ],
  ];
  for (const [what, fn] of steps) {
    if (!alive()) return;
    await step(deps, what, fn);
  }
}

/**
 * The engine's one watcher: created at start, told about every S the engine read or published
 * (so its own reads and publishes are never reported as changes), moved on rebinds, stopped once.
 */
export class WatcherLink {
  private watcher: FileWatcherPort | null = null;

  constructor(private readonly deps: SyncEngineDeps) {}

  open(sharedPath: string, listener: FileWatchListener, lastRead: SharedSnapshot | null): void {
    this.watcher = this.deps.createWatcher(sharedPath, listener);
    this.acknowledgeRead(lastRead);
    this.watcher.start();
  }

  close(): void {
    const w = this.watcher;
    this.watcher = null;
    w?.stop();
  }

  setSharedPath(sharedPath: string): void {
    this.watcher?.setSharedPath(sharedPath);
  }

  acknowledgeRead(snap: SharedSnapshot | null): void {
    if (snap === null) return;
    const { size, mtimeMs, ino } = snap.stat;
    this.watcher?.acknowledge({ size, mtimeMs, ino }, snap.sha256);
  }

  /** After our own publish: stat S now and acknowledge it with the published hash. */
  async acknowledgePublished(filePath: string, sha256: string): Promise<void> {
    if (this.watcher === null) return;
    try {
      const st = await this.deps.host.fs.stat(filePath);
      this.watcher?.acknowledge(st === null ? null : { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }, sha256);
    } catch (err) {
      this.deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not acknowledge our own publish`, errMeta(err));
    }
  }
}
