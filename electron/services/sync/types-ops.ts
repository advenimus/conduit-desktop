/**
 * Operation shapes for personal-vault sync: capture attribution and results (4.2, 4.3),
 * explicit local writes, merge results (4.5) and the materialization write plan (4.6).
 * Import through types.ts, which re-exports this file.
 */

import type {
  AppDot,
  ContentRow,
  EntryRow,
  EpochKeys,
  FolderRow,
  HistoryRow,
  RegKey,
  RowCache,
  RowKey,
  SyncState,
  SyncValue,
} from './types.js';
import type { HeldLegacyChange, LocalNotice } from './types-ui.js';

// ---------- Capture (4.2, 4.3) ----------

export interface LocalAttribution {
  readonly kind: 'local';
  /** One dot for the whole operation (already ticked by the caller). */
  readonly dot: AppDot;
  /** true: replace every sibling of each changed register. false: replace only the provisional. */
  readonly interactive: boolean;
}

/** Row filter used by G2 baseline absorb and by stale-by-nature candidates. */
export interface LegacyFilter {
  /** true = ignore every edit of this row (the row predates the baseline). */
  readonly skipRow?: (row: RowKey, content: ContentRow) => boolean;
  /** false = do not infer a delete for this row even though it vanished. */
  readonly allowDelete?: (row: RowKey) => boolean;
}

/** Looks up the value of a sibling identity in another replica (usually W). */
export type ValueRecovery = (key: RegKey, identityKey: string) => SyncValue | undefined;

export interface LegacyAttribution {
  readonly kind: 'legacy';
  /** mtime of the staged file (ms); delete times derive from it, clamped to now + 24 h. */
  readonly observedMtimeMs: number;
  /** Hold rule inputs (4.3 rule 2, 5.5). Hold is active when either is true. */
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
  /** Keys of the epoch the absorbed file is under (E_abs): pids use its kPid. */
  readonly absorbKeys: EpochKeys;
  /** SHA-256 hex of the absorbed bytes; stamped on held changes and notices. */
  readonly sourceSha256: string;
  readonly filter?: LegacyFilter;
  readonly recover?: ValueRecovery;
}

/**
 * An explicit register write by this device (resolution, restore, presence, claim, rekey...).
 * Built by capture-local.prepareWrite so vhash and ciphertext are always consistent.
 */
export interface LocalWrite {
  readonly key: RegKey;
  readonly value: SyncValue;
  readonly vhash: string;
  /** Default: 'replace-all' when interactive, else 'replace-provisional'. */
  readonly mode?: WriteMode;
}

/** replace-all: interactive. replace-provisional: non-interactive. reassert: rule R on `_life`. */
export type WriteMode = 'replace-all' | 'replace-provisional' | 'reassert';

export interface CaptureStats {
  readonly appWrites: number;
  readonly legacyEdits: number;
  readonly legacyDeletes: number;
  readonly legacyDropped: number;
  readonly legacyHeld: number;
  readonly staleReverts: number;
  readonly undecryptable: number;
}

export interface CaptureResult {
  readonly state: SyncState;
  readonly changed: boolean;
  readonly changedRows: readonly RowKey[];
  readonly notices: readonly LocalNotice[];
  readonly held: readonly HeldLegacyChange[];
  /** A legacy change was dropped or held: publish once so older apps see the kept values. */
  readonly contentRepairNeeded: boolean;
  readonly stats: CaptureStats;
  /**
   * Rows a per-operation capture compared (captureRows); undefined after a full pass. Pass it
   * to materialize as `capturedRows` so rows changed by writers that skipped the hook stay
   * untouched until the next full pass captures them.
   */
  readonly scope?: readonly RowKey[];
}

// ---------- Merge (4.5) ----------

export interface MergeReport {
  /** Registers where the guard kept a ∪ b (sync.invariant_violation). */
  readonly invariantViolations: readonly RegKey[];
}

export interface MergeResult {
  readonly state: SyncState;
  readonly report: MergeReport;
}

// ---------- Materialization (4.6) ----------

/** FK-safe write plan; state-store applies it in exactly this field order (4.6 step 5). */
export interface WritePlan {
  readonly upsertFolders: readonly FolderRow[];
  readonly upsertEntries: readonly EntryRow[];
  readonly upsertHistory: readonly HistoryRow[];
  readonly deleteHistory: readonly string[];
  readonly deleteEntries: readonly string[];
  readonly deleteFolders: readonly string[];
  /** vault_meta key -> value; null deletes the key. */
  readonly meta: ReadonlyMap<string, string | null>;
}

export interface CycleConflict {
  readonly kind: 'cycle';
  readonly tbl: 1 | 2;
  /** Row ids in the cycle, sorted. */
  readonly rowIds: readonly string[];
  /** The node whose container dot ranks highest; materialized at root. */
  readonly movedToRoot: string;
}

export type StructuralConflict = CycleConflict;

export interface MaterializeResult {
  /** Input state with `mat` overrides and graves recomputed. */
  readonly state: SyncState;
  readonly plan: WritePlan;
  /** New sync_row contents for every content row (tbl 1-3) the file will hold or held. */
  readonly cache: RowCache;
  readonly structural: readonly StructuralConflict[];
  /** Rows whose content changed (drives vault:entries-refreshed). */
  readonly changedRows: readonly RowKey[];
}
