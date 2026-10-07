/**
 * The merging half of one sync attempt (spec 5.6 commitMerge, 5.10 pre-merge snapshot, 4.1 dev
 * collision, 4.3 held legacy changes, 5.7 regressions, 5.8 different copies, 6.7 claims
 * hook): the merge and its commit under the generation
 * check, then the bookkeeping every merge owes (HLC receive, local.json, notices, conflicts,
 * session hooks, divergence, publish verification). Used only by sync-cycle.ts.
 */

import { knowledgeAutoResolutions } from './kb-auto-resolve.js';
import path from 'node:path';
import { listConflicts } from './conflicts.js';
import { digestState } from './digest.js';
import { adoptGenesis } from './genesis.js';
import { merge } from './merge.js';
import { regKeyStr } from './state-view.js';
import { guardDevCollision, type PreparedIncoming } from './sync-absorb.js';
import { takeMassSnapshot } from './sync-mass-snapshot.js';
import type { CommitOutcome, ReplicaPort } from './replica.js';
import type { SharedSnapshot } from './shared-file.js';
import type { CycleEnv } from './sync-cycle.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { CaptureResult, HeldLegacyChange, RegKey, SyncState } from './types.js';

export interface MergeStepResult {
  readonly state: SyncState;
  /** digest(M) == digest(S1) and no content repair is due: nothing to publish. */
  readonly upToDate: boolean;
  /** 5.6 content repair is due for this S (a legacy change was dropped or held, or S lacked sync tables). */
  readonly repairDue: boolean;
  /** Content rows the merge commit wrote or deleted. */
  readonly changedRows: number;
}

export type Mergeable = Extract<PreparedIncoming, { kind: 'merge' | 'adopt-genesis' }>;

function heldId(h: HeldLegacyChange): string {
  const s = h.sibling;
  return `${regKeyStr(h.key)}|${s.dev}:${s.ms}:${s.c}:${s.pid}`;
}

function appendHeld(prev: readonly HeldLegacyChange[], add: readonly HeldLegacyChange[]): readonly HeldLegacyChange[] {
  if (add.length === 0) return prev;
  const seen = new Set(prev.map(heldId));
  const fresh = add.filter((h) => !seen.has(heldId(h)));
  return fresh.length === 0 ? prev : [...prev, ...fresh];
}

/** 5.10: before a merge that deletes 10+ live rows or changes 25 % of them, keep W and a diff. */
async function massSnapshot(env: CycleEnv, w: SyncState, m: SyncState, snap: SharedSnapshot): Promise<void> {
  if (await takeMassSnapshot(env.deps, w, m, snap.sha256)) env.checkAlive();
}

/** Prompt items across non-snoozed conflict groups (7.2 badge). */
export function countConflicts(replica: ReplicaPort, state: SyncState): number {
  const local = replica.local();
  const repaired = local.notices.flatMap((n) => (n.kind === 'invariant-repair' && n.key !== null ? [regKeyStr(n.key)] : []));
  const labels = new Map(Object.entries(local.candidateLabels).map(([dev, label]) => [Number(dev), label] as const));
  const groups = listConflicts(state, {
    implicit: replica.implicit(),
    structural: replica.structural(),
    snoozed: new Set(local.snoozed.map((s) => s.key)),
    candidateLabels: labels,
    repairedKeys: new Set(repaired),
    keys: replica.ring(),
  });
  return groups.filter((g) => !g.snoozed).reduce((n, g) => n + g.items.length, 0);
}

function recordHeld(env: CycleEnv, snap: SharedSnapshot, capture: CaptureResult): void {
  const { replica, status } = env.deps;
  const local = replica.updateLocal((l) => {
    const heldLegacy = appendHeld(l.heldLegacy, capture.held);
    return heldLegacy === l.heldLegacy && l.lastMergedSha256 === snap.sha256 ? l : { ...l, lastMergedSha256: snap.sha256, heldLegacy };
  });
  if (local.heldLegacy.length === 0) return;
  const deletes = local.heldLegacy.filter((h) => h.kind === 'delete').length;
  status.setPrompt({ kind: 'held-legacy', id: 'held-legacy', deletes, reverts: local.heldLegacy.length - deletes });
}

function bookkeeping(env: CycleEnv, snap: SharedSnapshot, committed: CommitOutcome, capture: CaptureResult, violations: readonly RegKey[]): void {
  const { replica, notices, status, session } = env.deps;
  replica.receive(committed.state);
  recordHeld(env, snap, capture);
  if (capture.notices.length > 0) notices.addFromCapture(capture.notices);
  for (const key of violations) notices.add({ kind: 'invariant-repair', key, sourceSha256: snap.sha256, count: 1 });
  // Knowledge-article bookkeeping conflicts are settled here; the next cycle publishes the writes.
  const autoWrites = knowledgeAutoResolutions(committed.state, replica.context());
  if (autoWrites.length > 0) replica.applyWrites(autoWrites, { interactive: true });
  status.setConflicts(countConflicts(replica, replica.state()));
  session.afterMerge(replica.state());
}

function observeDivergence(env: CycleEnv, state: SyncState, sState: SyncState | null): void {
  const { replica, divergence, binding, session, status, host } = env.deps;
  const findings = divergence.observe({
    state,
    ownDeviceUuid: replica.deviceUuid,
    ownHint: binding.fileHint(),
    sessions: session.sessions(),
    sharedVv: sState?.vv ?? null,
    nowMs: host.clock.now(),
    lastOwnPublishMs: env.memory.lastPublishMs,
  });
  for (const f of findings) {
    status.setPrompt({
      kind: 'different-copies',
      id: `different-copies:${f.deviceUuid}`,
      deviceUuid: f.deviceUuid,
      deviceName: f.deviceName,
      theirs: f.theirs,
      ours: f.ours,
    });
  }
}

/** 5.7 on every synced read: a lost publish counts once; the cycle then republishes (M differs from S1). */
function noteRegression(env: CycleEnv, sState: SyncState | null): void {
  if (sState === null || env.verifier.check(sState) !== 'regressed' || !env.verifier.claimLoss()) return;
  const until = env.regressions.record(env.deps.host.clock.now());
  env.deps.host.logger.info(`${SYNC_LOG_PREFIX} the shared file no longer covers our last publish`, { backoffUntilMs: until });
}

function noteCollision(env: CycleEnv, s1: SyncState, snap: SharedSnapshot): void {
  const collision = guardDevCollision(env.deps.replica, s1);
  if (collision.kind === 'none') return;
  env.deps.host.logger.warn(`${SYNC_LOG_PREFIX} sync.dev_collision`, { oldDev: collision.oldDev, newDev: collision.newDev });
  env.deps.notices.toast('dev-collision', { fileName: path.basename(snap.path) });
}

type CommitMergeFn = (replica: ReplicaPort, m: SyncState, gen0: number) => CommitOutcome;

/** Steps 5-7: collision guard, merge (or G3 adoption), snapshot, commit, bookkeeping. */
export async function mergeStep(
  env: CycleEnv,
  snap: SharedSnapshot,
  sState: SyncState | null,
  prepared: Mergeable,
  commitMerge: CommitMergeFn,
): Promise<MergeStepResult> {
  const { replica } = env.deps;
  noteCollision(env, prepared.s1, snap);
  let committed: CommitOutcome;
  let violations: readonly RegKey[] = [];
  if (prepared.kind === 'adopt-genesis') {
    // merge(Wnow, M) would fail the genesis precondition: adopt against W as it is at commit time.
    committed = replica.commitWith((cur) => adoptGenesis(cur, prepared.s1, replica.implicit()).merged.state);
  } else {
    const gen0 = replica.generation();
    const w = replica.state();
    const m = merge(w, prepared.s1, replica.implicit());
    violations = m.report.invariantViolations;
    await massSnapshot(env, w, m.state, snap);
    committed = commitMerge(replica, m.state, gen0);
  }
  bookkeeping(env, snap, committed, prepared.capture, violations);
  observeDivergence(env, committed.state, sState);
  noteRegression(env, sState);
  const repairDue = prepared.capture.contentRepairNeeded && !replica.local().contentRepairShas.includes(snap.sha256);
  const upToDate = !repairDue && digestState(committed.state) === digestState(prepared.s1);
  return { state: committed.state, upToDate, repairDue, changedRows: committed.changedRows.length };
}
