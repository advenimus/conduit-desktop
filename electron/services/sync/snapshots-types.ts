/**
 * Constants and shapes of pre-merge snapshots and targeted undo (spec 5.10, 12 rows 34/43).
 * Import through snapshots.ts, which re-exports this file.
 */

import type Database from 'better-sqlite3';
import type { EncodedValue } from './value-codec.js';
import type { ImplicitProvider, KeyRing, LocalWrite, RegKey, RowKey, SyncContext, SyncState } from './types.js';

export const MASS_DELETE_MIN_ROWS = 10;
export const MASS_CHANGE_RATIO = 0.25;
export const MASS_CHANGE_MIN_ROWS = 10;
export const SNAPSHOT_KEEP = 5;
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_DB_FILE = 'w.conduit';
export const SNAPSHOT_DIFF_FILE = 'diff.json';

export interface DeletedRowRecord {
  readonly row: RowKey;
  readonly title: string;
  /** Provisional values before the merge, per register name (secrets: ciphertext under `epochId`). */
  readonly values: Readonly<Record<string, EncodedValue>>;
}

export interface ChangedFieldRecord {
  readonly key: RegKey;
  readonly before: EncodedValue;
  readonly after: EncodedValue;
  readonly secret: boolean;
}

export interface MergeDiff {
  /** Live entries and folders before the merge. */
  readonly liveBefore: number;
  readonly deleted: readonly DeletedRowRecord[];
  /** Fields of rows live on both sides whose provisional value changed. */
  readonly changed: readonly ChangedFieldRecord[];
  /** Distinct rows in `changed`. */
  readonly changedRows: number;
  /** Device the deletes came from (dev of the `_life = dead` dots via devs), when one. */
  readonly byDeviceUuid: string | null;
}

export interface SnapshotMeta {
  readonly id: string;
  readonly createdMs: number;
  /** SHA-256 of the S whose merge this snapshot precedes. */
  readonly sourceSha256: string;
  /** Id of the 'mass-change' LocalNotice ([Review] [Undo]). */
  readonly noticeId: string;
  /** Epoch the diff's secret ciphertexts are under. */
  readonly epochId: string;
  readonly deleted: number;
  readonly changedRows: number;
  readonly byDeviceUuid: string | null;
}

export interface SnapshotRef {
  readonly id: string;
  readonly dir: string;
  readonly meta: SnapshotMeta;
}

export interface TakeSnapshotInput {
  /** W's connection BEFORE the merge commit (VACUUM INTO outside any transaction). */
  readonly db: Database.Database;
  readonly diff: MergeDiff;
  readonly sourceSha256: string;
  readonly noticeId: string;
  readonly epochId: string;
}

export interface UndoRowPreview {
  readonly row: RowKey;
  readonly title: string;
  /** false when the row is live again (someone restored it): nothing to undo. */
  readonly stillDeleted: boolean;
}

export interface UndoFieldPreview {
  readonly key: RegKey;
  readonly label: string;
  /** false when the field no longer holds the merged value: undo skips it. */
  readonly stillMerged: boolean;
  readonly secret: boolean;
}

export interface UndoPreview {
  readonly snapshotId: string;
  readonly rows: readonly UndoRowPreview[];
  readonly fields: readonly UndoFieldPreview[];
}

export interface UndoChoice {
  readonly rows: readonly RowKey[];
  readonly fields: readonly RegKey[];
}

export interface SnapshotRekeyReport {
  /** Snapshots whose diff.json is now under the ring's current epoch. */
  readonly rekeyed: number;
  /** Folders removed: the snapshots' copies of W, unreadable snapshots, leftovers of failed takes. */
  readonly removed: number;
  /** Steps that failed (logged); the old password may still open what they left. */
  readonly failed: number;
}

export interface SnapshotStorePort {
  take(input: TakeSnapshotInput): Promise<SnapshotRef>;
  /** Newest first. */
  list(): Promise<readonly SnapshotRef[]>;
  loadDiff(id: string): Promise<{ readonly meta: SnapshotMeta; readonly diff: MergeDiff }>;
  /** Keeps SNAPSHOT_KEEP newest within SNAPSHOT_MAX_AGE_MS; returns the removed count. */
  prune(nowMs: number): Promise<number>;
  /**
   * `ring` (optional) lets a secret field whose ciphertext changed since the merge (a password
   * change re-encrypted it) still count as merged when its plaintext is unchanged; without it
   * a secret counts as merged only while it holds the merged ciphertext bytes.
   */
  undoPreview(id: string, current: SyncState, implicit: ImplicitProvider, ring?: KeyRing): Promise<UndoPreview>;
  /**
   * Interactive writes for one dot: `_life = live` plus the snapshot's values for chosen rows
   * still dead; old values for chosen fields still holding the merged value. Secrets are
   * decrypted with `ring` (the snapshot epoch must be reachable) and re-encrypted via prepareWrite.
   */
  undoWrites(id: string, current: SyncState, choice: UndoChoice, ring: KeyRing, ctx: SyncContext): Promise<readonly LocalWrite[]>;
  /**
   * After a password change on this device (4.8): removes each snapshot's copy of W (undo reads
   * only diff.json) and rewrites diff.json with its secrets under ring.current. Never throws;
   * each failure is logged and counted.
   */
  rekey(ring: KeyRing): Promise<SnapshotRekeyReport>;
}
