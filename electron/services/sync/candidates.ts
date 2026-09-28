/**
 * Candidates (spec 4.9): files merged on purpose (1.0.5 sandbox, copies, leftover WAL copies,
 * user-picked files, G2 without baseline, G3 leftovers). Replica candidates are absorbed
 * against their own sync tables, then merged; synthetic candidates mint differences as app
 * dots of a fresh dev_syn at ms 0 (never deletes). Builds the preview model and applies.
 * Split into candidates-replica.ts, candidates-synthetic.ts and candidates-shared.ts.
 */

import { prepareWrite } from './capture-local.js';
import { LIFE_DEAD, LIFE_REG, isContentTbl, regKey } from './catalog.js';
import { merge } from './merge.js';
import { rowLife } from './state-view.js';
import type { CandidateKind, ImplicitProvider, LocalWrite, MergeResult, RowKey, SyncContext, SyncState } from './types.js';

export { absorbReplicaCandidate, type CandidateMeta, type ReplicaAbsorbResult } from './candidates-replica.js';
export {
  buildSyntheticCandidate,
  buildSyntheticFromRows,
  candidateRowsFromContent,
  type SyntheticCandidate,
  type SyntheticOptions,
} from './candidates-synthetic.js';

export interface CandidateFileInfo {
  readonly hasSyncTables: boolean;
  readonly lineageId: string | null;
  readonly genesisId: string | null;
}

/** Replica: sync tables, same lineage, same genesis. Everything else: synthetic. */
export function classifyCandidate(info: CandidateFileInfo, m: SyncState): CandidateKind {
  const replica = info.hasSyncTables && info.lineageId === m.lineageId && info.genesisId === m.genesisId;
  return replica ? 'replica' : 'synthetic';
}

/** [Merge and review]: merge(M, candidate state). Differences surface as labeled conflicts. */
export function applyCandidate(m: SyncState, candidate: SyncState, implicit: ImplicitProvider): MergeResult {
  return merge(m, candidate, implicit);
}

/**
 * "Items missing from this copy" [Delete them too]: interactive `_life = dead` writes for one
 * dot. Rows M does not hold live (unknown, already dead, not content) are skipped.
 */
export function deleteMissingWrites(m: SyncState, rows: readonly RowKey[], ctx: SyncContext): LocalWrite[] {
  return rows
    .filter((row) => isContentTbl(row.tbl) && rowLife(m, row) === 'live')
    .map((row) => prepareWrite(regKey(row.tbl, row.rowId, LIFE_REG), { value: LIFE_DEAD }, ctx, 'replace-all'));
}
