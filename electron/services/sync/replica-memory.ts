/**
 * The in-memory W of an open replica (spec 5.6 W.gen): the last committed
 * snapshot, the generation counter, commits over W's single connection, generation-checked and
 * computed commits in one IMMEDIATE transaction, and resynchronization with the file when a
 * commit made inside someone else's transaction was never confirmed. Import through replica.ts.
 */

import type Database from 'better-sqlite3';
import { SYNC_LOG_PREFIX, type SyncLogger } from './host.js';
import { loadSnapshot, materializeAndSave, verifyRoundTrip } from './replica-commit.js';
import type { CommitOptions, CommitOutcome, WorkingSnapshot } from './replica-types.js';
import { currentEpochId } from './state-view.js';
import { SyncCoreError, type ImplicitProvider, type RowKey, type StructuralConflict, type SyncState } from './types.js';

export interface WorkingStateDeps {
  readonly db: Database.Database;
  readonly lineageId: string;
  readonly logger: SyncLogger;
  readonly verifyCommits: boolean;
  /** The key ring's current epoch: the only epoch a committed state may be in. */
  readonly ringEpochId: () => string;
  readonly implicit: () => ImplicitProvider;
  /** After every save (the high-water stamp). */
  readonly saved: (state: SyncState) => void;
  readonly contentChanged: (rows: readonly RowKey[]) => void;
  /**
   * 4.2 step 6 inside our write transaction: commits a capture of writes that skipped the hooks
   * (W.gen moves when it captured anything), so the commit that follows never reverts them.
   */
  readonly catchUp: () => void;
}

interface Memory {
  readonly snap: WorkingSnapshot;
  readonly gen: number;
  readonly structural: readonly StructuralConflict[];
}

export class WorkingState {
  private mem: Memory;
  /** Depth of our own write transactions (commitIfGeneration, commitWith). */
  private ownTx = 0;
  /** A commit ran inside someone else's transaction whose outcome we have not heard yet. */
  private unconfirmed = false;

  constructor(
    private readonly deps: WorkingStateDeps,
    snapshot: WorkingSnapshot,
    structural: readonly StructuralConflict[],
  ) {
    this.mem = { snap: snapshot, gen: 0, structural };
  }

  snapshot(): WorkingSnapshot {
    return this.mem.snap;
  }

  generation(): number {
    return this.mem.gen;
  }

  structural(): readonly StructuralConflict[] {
    return this.mem.structural;
  }

  /** A captured mutation that changed nothing still moves W.gen (5.6). */
  bump(): void {
    this.mem = { ...this.mem, gen: this.mem.gen + 1 };
  }

  /** The mutator's transaction committed (afterCommit). */
  confirmed(): void {
    this.unconfirmed = false;
  }

  /** Before any operation: a commit inside a transaction that ended without confirmation is reloaded. */
  confirm(): void {
    if (this.unconfirmed && !this.deps.db.inTransaction) this.reload('a commit inside another transaction was not confirmed');
  }

  reload(reason: string): void {
    this.deps.logger.warn(`${SYNC_LOG_PREFIX} reloading the working copy from disk`, { reason });
    const loaded = loadSnapshot(this.deps.db, this.deps.lineageId);
    this.mem = { snap: loaded.snapshot, gen: this.mem.gen + 1, structural: loaded.structural };
    this.unconfirmed = this.deps.db.inTransaction && this.ownTx === 0;
  }

  commit(next: SyncState, opts: CommitOptions): CommitOutcome {
    if (currentEpochId(next) !== this.deps.ringEpochId()) {
      throw new SyncCoreError('KEY_MISMATCH', `${SYNC_LOG_PREFIX} refusing to materialize a state of another key epoch`);
    }
    const snap = this.mem.snap;
    const base = { baseline: snap.state, cache: snap.cache, fileId: snap.fileId };
    const saved = materializeAndSave(this.deps.db, this.deps.implicit(), base, next, opts);
    if (this.deps.db.inTransaction && this.ownTx === 0) this.unconfirmed = true;
    this.mem = { snap: saved.snapshot, gen: this.mem.gen + 1, structural: saved.structural };
    if (this.deps.verifyCommits) verifyRoundTrip(this.deps.db, saved.snapshot);
    this.deps.saved(saved.snapshot.state);
    if (opts.notify !== false && saved.changedRows.length > 0) this.deps.contentChanged(saved.changedRows);
    return { state: saved.snapshot.state, changedRows: saved.changedRows, structural: saved.structural, generation: this.mem.gen };
  }

  /** A catch-up capture counts as a generation change: the caller merges again (5.6 commitMerge). */
  commitIfGeneration(next: SyncState, expected: number, opts: CommitOptions): CommitOutcome | null {
    return this.inWriteTransaction(() => {
      if (this.mem.gen !== expected) return null;
      this.deps.catchUp();
      return this.mem.gen === expected ? this.commit(next, opts) : null;
    });
  }

  commitWith(fn: (w: SyncState) => SyncState, opts: CommitOptions): CommitOutcome {
    return this.inWriteTransaction(() => {
      this.deps.catchUp();
      return this.commit(fn(this.mem.snap.state), opts);
    });
  }

  /** One IMMEDIATE transaction; on failure the in-memory W goes back to what the file still holds. */
  private inWriteTransaction<T>(fn: () => T): T {
    const before = this.mem;
    this.ownTx++;
    try {
      const out = this.deps.db.transaction(fn).immediate();
      // Inside someone else's transaction our savepoint can still be rolled back with it.
      if (this.deps.db.inTransaction && this.ownTx === 1) this.unconfirmed = true;
      return out;
    } catch (err) {
      this.mem = before;
      throw err;
    } finally {
      this.ownTx--;
    }
  }
}
