/**
 * W commit primitives (spec 4.6): materialize a state over W's content and
 * save it diffed against the in-memory snapshot, verify the round trip in tests, reload the
 * snapshot from disk, and read this dev's own version-vector row for the high-water check.
 * Import through replica.ts.
 */

import type Database from 'better-sqlite3';
import { digestState } from './digest.js';
import { SYNC_LOG_PREFIX } from './host.js';
import { materialize, resolveContainers } from './materialize.js';
import { currentEpochId } from './state-view.js';
import { loadContent, loadFile, saveState } from './state-store.js';
import {
  SYNC_FORMAT,
  SyncCoreError,
  type Dev,
  type Hlc,
  type ImplicitProvider,
  type LoadedFile,
  type RowCache,
  type RowKey,
  type StructuralConflict,
  type SyncState,
} from './types.js';
import type { CommitOptions, WorkingSnapshot } from './replica-types.js';

export interface SavedCommit {
  readonly snapshot: WorkingSnapshot;
  readonly changedRows: readonly RowKey[];
  readonly structural: readonly StructuralConflict[];
}

/** What W held before the save: the diff baseline (null rewrites every sync table). */
export interface CommitBase {
  readonly baseline: SyncState | null;
  readonly cache: RowCache;
  readonly fileId: string | null;
}

/** Materialize `next` over W's content (or `opts.content`), save it in one transaction. */
export function materializeAndSave(
  db: Database.Database,
  implicit: ImplicitProvider,
  base: CommitBase,
  next: SyncState,
  opts: CommitOptions,
): SavedCommit {
  const content = opts.content ?? loadContent(db);
  const epochId = currentEpochId(next);
  const currentEpoch = epochId === null ? null : next.epochs.get(epochId) ?? null;
  const mctx = opts.capturedRows === undefined ? { implicit, currentEpoch } : { implicit, currentEpoch, capturedRows: opts.capturedRows };
  const m = materialize(next, content, base.cache, mctx);
  const baseline: LoadedFile | null =
    base.baseline === null
      ? null
      : { state: base.baseline, content, cache: base.cache, fileId: base.fileId, syncFormat: SYNC_FORMAT };
  const fileId = opts.fileId === undefined ? base.fileId : opts.fileId;
  if (opts.fileId === undefined) saveState(db, { state: m.state, plan: m.plan, cache: m.cache, baseline });
  else saveState(db, { state: m.state, plan: m.plan, cache: m.cache, baseline, fileId: opts.fileId });
  return { snapshot: { state: m.state, cache: m.cache, fileId }, changedRows: m.changedRows, structural: m.structural };
}

/** Tests (verifyCommits): what was saved must load back with the same digest and file_id. */
export function verifyRoundTrip(db: Database.Database, snapshot: WorkingSnapshot): void {
  const reloaded = loadFile(db);
  if (digestState(reloaded.state) !== digestState(snapshot.state)) {
    throw new SyncCoreError('INVARIANT', `${SYNC_LOG_PREFIX} the committed state does not load back identically`);
  }
  if (reloaded.fileId !== snapshot.fileId) {
    throw new SyncCoreError('INVARIANT', `${SYNC_LOG_PREFIX} the committed file_id does not load back identically`);
  }
}

export interface LoadedSnapshot {
  readonly snapshot: WorkingSnapshot;
  readonly structural: readonly StructuralConflict[];
}

/** W's sync state from disk; another lineage is CORRUPT_STATE (W belongs to its lineage folder). */
export function loadSnapshot(db: Database.Database, lineageId: string): LoadedSnapshot {
  const f = loadFile(db);
  if (f.state.lineageId !== lineageId) {
    throw new SyncCoreError('CORRUPT_STATE', `${SYNC_LOG_PREFIX} the working copy belongs to another lineage`);
  }
  return {
    snapshot: { state: f.state, cache: f.cache, fileId: f.fileId },
    structural: resolveContainers(f.state).cycles,
  };
}

/** Prepared reader of W's own sync_vv row (4.1: the high-water check reads the file, not memory). */
export function ownVvReader(db: Database.Database): (dev: Dev) => Hlc | null {
  const stmt = db.prepare('SELECT hlc_ms AS ms, hlc_c AS c FROM sync_vv WHERE dev = ?');
  return (dev) => {
    const row = stmt.get(dev) as { ms: number; c: number } | undefined;
    return row === undefined ? null : { ms: Number(row.ms), c: Number(row.c) };
  };
}

export function sameHlc(a: Hlc | null | undefined, b: Hlc | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return a.ms === b.ms && a.c === b.c;
}
