/**
 * One sync cycle (spec 5.6 syncCycle and commitMerge, 5.3 publish step 1, 5.7, 5.10 snapshot,
 * 4.3 content repair, 6.7 claims hook): high-water check, full capture pass, read and classify
 * S, absorb (sync-absorb.ts), dev-collision guard, merge, commitMerge with the generation check,
 * mass-change snapshot, up-to-date test, publish-blocked test, presence marker + file_id, VACUUM
 * INTO, CAS publish, marker report, verification schedule. Called only by SyncEngine inside its
 * lane. Every await is followed by an alive/deadline check.
 * Parts: sync-cycle-read.ts, sync-cycle-merge.ts, sync-cycle-publish.ts.
 */

import path from 'node:path';
import { merge } from './merge.js';
import { prepareIncoming, type PreparedIncoming } from './sync-absorb.js';
import { freshSideFiles, readBaseline, readStep, tornStep } from './sync-cycle-read.js';
import { mergeStep } from './sync-cycle-merge.js';
import { publishStep, type PublishTarget } from './sync-cycle-publish.js';
import { COMMIT_ATTEMPTS, CYCLE_ATTEMPTS } from './sync-engine-constants.js';
import type { CommitOutcome, ReplicaPort } from './replica.js';
import type { SharedClass, SharedSnapshot, TornTracker } from './shared-file.js';
import type { PublishVerifier, RegressionTracker } from './sync-verify.js';
import type { CycleOutcome, SyncEngineDeps, SyncTrigger } from './sync-engine.js';
import { SYNC_LOG_PREFIX, type PauseReason, type SyncPrompt } from './host.js';
import type { SyncState } from './types.js';

/** One missing-file episode of 5.9: S at `path` missing since `sinceMs` (the binding's debounce start). */
export interface MissingEpisode {
  readonly path: string;
  readonly sinceMs: number;
}

/** Mutable per-engine memory the cycle reads and updates (owned by SyncEngine). */
export interface CycleMemory {
  lastShared: SharedSnapshot | null;
  /** The missing episode whose folder was already searched (rebind or prompt); null once S is read. */
  missingProbed: MissingEpisode | null;
  /** Local operations since the last successful publish ("N changes not yet synced"). */
  unsyncedOps: number;
  lastPublishMs: number | null;
}

export interface CycleEnv {
  readonly deps: SyncEngineDeps;
  readonly torn: TornTracker;
  readonly verifier: PublishVerifier;
  readonly regressions: RegressionTracker;
  readonly memory: CycleMemory;
  /** Throws CycleAborted when the engine stopped or the deadline passed. */
  readonly checkAlive: () => void;
  /** Final cycles write presence session_open = 0. */
  readonly closing: boolean;
  /** Runs a W write the engine must not count as a user edit (the publish marker). */
  readonly ownWrites?: <T>(fn: () => T) => T;
}

export class CycleAborted extends Error {
  constructor(readonly why: 'stopped' | 'deadline') {
    super(`sync cycle aborted: ${why}`);
    this.name = 'CycleAborted';
  }
}

const EPOCH_PROMPTS = ['epoch-newer', 'epoch-legacy', 'epoch-concurrent'] as const;
const FOREIGN_PROMPTS = ['foreign-newer-format', 'foreign-other-vault'] as const;

type Attempt = { readonly kind: 'again' } | { readonly kind: 'done'; readonly outcome: CycleOutcome };

const AGAIN: Attempt = Object.freeze({ kind: 'again' });

function done(outcome: CycleOutcome): Attempt {
  return { kind: 'done', outcome };
}

/**
 * 5.6 commitMerge: up to COMMIT_ATTEMPTS replica.commitIfGeneration(M, gen0); on a changed
 * generation M = merge(W now, M) (idempotent, M already contains S1) and retry; finally
 * replica.commitWith(w => merge(w, M).state). Returns the committed outcome.
 */
export function commitMerge(replica: ReplicaPort, m: SyncState, gen0: number): CommitOutcome {
  let next = m;
  let gen = gen0;
  for (let i = 0; i < COMMIT_ATTEMPTS; i++) {
    const out = replica.commitIfGeneration(next, gen);
    if (out !== null) return out;
    gen = replica.generation();
    next = merge(replica.state(), next, replica.implicit()).state;
  }
  return replica.commitWith((w) => merge(w, next, replica.implicit()).state);
}

export interface PublishBlockInput {
  readonly killSwitch: boolean;
  readonly softLocked: boolean;
  readonly sideFilesPublishAllowed: boolean;
  readonly serverSideFilesFlagRecent: boolean;
  readonly epochPaused: boolean;
  readonly foreign: boolean;
  readonly regressionBlockedUntilMs: number | null;
  readonly nowMs: number;
}

/** 5.6 publishBlocked(): the first applicable reason, or null. */
export function publishBlockReason(input: PublishBlockInput): PauseReason | null {
  if (input.killSwitch) return 'kill-switch';
  if (input.softLocked) return 'displaced';
  if (!input.sideFilesPublishAllowed || input.serverSideFilesFlagRecent) return 'side-files';
  if (input.epochPaused) return 'epoch-newer';
  if (input.foreign) return 'foreign-other-vault';
  if (input.regressionBlockedUntilMs !== null && input.regressionBlockedUntilMs > input.nowMs) return 'regression-backoff';
  return null;
}

/** Epoch pauses and foreign files return before any publish, so only the live facts remain. */
function blockNow(env: CycleEnv): PauseReason | null {
  const { host, session, sideFiles } = env.deps;
  const now = host.clock.now();
  return publishBlockReason({
    killSwitch: host.flags.personalSyncPaused(),
    softLocked: session.softLocked(),
    sideFilesPublishAllowed: sideFiles.view().publishAllowed,
    serverSideFilesFlagRecent: session.serverSideFilesFlagRecent(now),
    epochPaused: false,
    foreign: false,
    regressionBlockedUntilMs: env.regressions.blockedUntil(now),
    nowMs: now,
  });
}

async function publishOrBlock(env: CycleEnv, target: PublishTarget): Promise<Attempt> {
  const reason = blockNow(env);
  if (reason !== null) return done({ kind: 'merged-not-published', reason });
  env.checkAlive();
  const res = await publishStep(env, target);
  env.checkAlive();
  if (res.kind === 'changed') return AGAIN;
  if (res.kind === 'failed') {
    env.deps.host.logger.warn(`${SYNC_LOG_PREFIX} publish failed`, { code: res.code });
    env.deps.notices.toast('publish-failed', { code: res.code, fileName: path.basename(env.deps.binding.sharedPath()) });
    return done({ kind: 'error', message: res.code ?? 'publish-failed' });
  }
  return done(res);
}

function pause(env: CycleEnv, prompt: SyncPrompt, reason: PauseReason): Attempt {
  env.deps.status.setPrompt(prompt);
  return done({ kind: 'paused', reason });
}

/** Never written to: a foreign file only ever gets a prompt (5.2). */
function foreign(env: CycleEnv, cls: Extract<SharedClass, { kind: 'foreign-newer' | 'foreign-other' }>): Attempt {
  const sharedPath = env.deps.binding.sharedPath();
  env.deps.host.logger.info(`${SYNC_LOG_PREFIX} the shared file is not this vault's; publishing stopped`, { kind: cls.kind });
  if (cls.kind === 'foreign-newer') {
    const prompt: SyncPrompt = { kind: 'foreign-newer-format', id: 'foreign-newer-format', path: sharedPath, syncFormat: cls.syncFormat };
    return pause(env, prompt, 'foreign-newer-format');
  }
  return pause(env, { kind: 'foreign-other-vault', id: 'foreign-other-vault', path: sharedPath }, 'foreign-other-vault');
}

async function prepare(env: CycleEnv, snap: SharedSnapshot, cls: Extract<SharedClass, { kind: 'presync' | 'synced' }>): Promise<PreparedIncoming> {
  const { replica, session, candidates, host, binding } = env.deps;
  const side = await freshSideFiles(env, binding.sharedPath());
  // 5.5: held changes wait for the user, so the same S keeps holding after the side files go.
  const stillHeld = replica.local().heldLegacy.some((h) => h.sourceSha256 === snap.sha256);
  const baseline = cls.kind === 'presync' ? await readBaseline(env) : null;
  env.checkAlive();
  const prepared = await prepareIncoming({
    replica,
    snapshot: snap,
    cls,
    sideFilesPresent: side.holdLegacy || stillHeld,
    serverSideFilesFlagRecent: session.serverSideFilesFlagRecent(host.clock.now()),
    baseline,
    candidates,
    host,
  });
  env.checkAlive();
  return prepared;
}

function candidatePrompt(env: CycleEnv, candidateId: string, fallbackLabel: string): void {
  const c = env.deps.candidates.list().find((x) => x.id === candidateId);
  env.deps.status.setPrompt({ kind: 'candidate', id: `candidate:${candidateId}`, candidateId, label: c?.label ?? fallbackLabel });
}

async function absorbAndPublish(env: CycleEnv, snap: SharedSnapshot, cls: Extract<SharedClass, { kind: 'presync' | 'synced' }>): Promise<Attempt> {
  const { replica, status } = env.deps;
  const sState = cls.kind === 'synced' ? cls.file.state : null;
  const prepared = await prepare(env, snap, cls);
  if (prepared.kind === 'paused') return pause(env, prepared.prompt, prepared.reason);
  for (const id of EPOCH_PROMPTS) status.clearPrompt(id);
  const target: PublishTarget = {
    expectedSha256: snap.sha256,
    observedMtimeMs: snap.stat.mtimeMs,
    sFileId: cls.kind === 'synced' ? cls.file.fileId : null,
    repairSha: null,
  };
  if (prepared.kind === 'queued') {
    candidatePrompt(env, prepared.candidateId, '');
    return publishOrBlock(env, { ...target, repairSha: snap.sha256 });
  }
  const merged = await mergeStep(env, snap, sState, prepared, commitMerge);
  if (prepared.kind === 'adopt-genesis' && prepared.candidateId !== null) candidatePrompt(env, prepared.candidateId, '');
  if (merged.upToDate) {
    if (replica.local().pendingPublish) replica.updateLocal((l) => ({ ...l, pendingPublish: false }));
    return done({ kind: 'up-to-date', merged: merged.changedRows > 0 });
  }
  return publishOrBlock(env, { ...target, repairSha: merged.repairDue ? snap.sha256 : null });
}

/** One read-classify-merge-publish attempt (spec 5.6). */
async function attempt(env: CycleEnv): Promise<Attempt> {
  const { replica, shared, status, session } = env.deps;
  const read = await readStep(env);
  if (read.kind === 'again') return AGAIN;
  if (read.kind === 'done') return done(read.outcome);
  const snap = read.snapshot;
  const cls = shared.classify(snap, { lineageId: replica.lineageId });
  if (cls.kind === 'unreadable') {
    const torn = await tornStep(env, snap);
    if (torn.kind === 'retry') return done(torn.outcome);
    return publishOrBlock(env, { expectedSha256: snap.sha256, observedMtimeMs: snap.stat.mtimeMs, sFileId: null, repairSha: null });
  }
  env.torn.reset();
  if (cls.kind === 'foreign-newer' || cls.kind === 'foreign-other') return foreign(env, cls);
  for (const id of FOREIGN_PROMPTS) status.clearPrompt(id);
  if (cls.kind === 'synced') session.sharedRead(cls.file.state);
  return absorbAndPublish(env, snap, cls);
}

async function body(env: CycleEnv): Promise<CycleOutcome> {
  const { replica, session, host } = env.deps;
  if (session.softLocked()) return { kind: 'skipped', reason: 'soft-locked' };
  replica.highWaterCheck();
  replica.fullPass();
  if (host.flags.personalSyncPaused()) return { kind: 'skipped', reason: 'kill-switch' };
  for (let i = 0; i < CYCLE_ATTEMPTS; i++) {
    const res = await attempt(env);
    if (res.kind === 'done') return res.outcome;
  }
  host.logger.info(`${SYNC_LOG_PREFIX} the shared file kept changing; backing off`, { attempts: CYCLE_ATTEMPTS });
  // untilMs 0: the engine's error back-off decides the next attempt (5 s doubling).
  return { kind: 'backoff', untilMs: 0 };
}

function isAborted(err: unknown): boolean {
  return err instanceof CycleAborted || (err as { name?: unknown } | null)?.name === 'CycleAborted';
}

/** The 5.6 cycle body. Never throws except CycleAborted; other errors become { kind: 'error' }. */
export async function runSyncCycle(env: CycleEnv, reason: SyncTrigger): Promise<CycleOutcome> {
  try {
    return await body(env);
  } catch (err) {
    if (isAborted(err)) throw err;
    const e = err as { name?: unknown; code?: unknown } | null;
    const name = typeof e?.name === 'string' ? e.name : 'Error';
    const code = typeof e?.code === 'string' ? e.code : null;
    env.deps.host.logger.error(`${SYNC_LOG_PREFIX} cycle failed`, { reason, name, code });
    return { kind: 'error', message: name };
  }
}
