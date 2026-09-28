/**
 * Replica candidates (spec 4.9): a file with sync tables, the same lineage and the same genesis
 * is absorbed against its own sync tables (4.3), aligned to M's key epoch and previewed against
 * M. A stale replica contributes nothing. Import through candidates.ts.
 */

import { captureLegacy } from './capture-legacy.js';
import { LIFE_DEAD, LIFE_REG, isContentTbl } from './catalog.js';
import { isItemTbl, previewField, previewRow, provisionalView, regKeyOf, rowTitle } from './candidates-shared.js';
import { makeImplicitProvider } from './hashing.js';
import { alignEpoch, type FileKeyMeta } from './key-epoch.js';
import { covered, merge } from './merge.js';
import { isEligible, isPseudo } from './sibling.js';
import { currentEpochId, rowLife } from './state-view.js';
import {
  SyncCoreError,
  type CandidatePreview,
  type CandidateSource,
  type CaptureResult,
  type ContentSnapshot,
  type ImplicitProvider,
  type LegacyAttribution,
  type LoadedFile,
  type PreviewField,
  type PreviewRow,
  type RowState,
  type SyncContext,
  type SyncState,
} from './types.js';

const META_SALT_KEY = 'salt';
const META_VERIFICATION_KEY = 'verification';

export interface ReplicaAbsorbResult {
  /** The candidate's state after legacy absorption and epoch alignment, ready to merge. */
  readonly state: SyncState;
  readonly capture: CaptureResult;
  /** Its contribution to M is only uncovered app dots: merge without asking (4.9). */
  readonly appDotsOnly: boolean;
  readonly preview: CandidatePreview;
}

export interface CandidateMeta {
  readonly source: CandidateSource;
  readonly label: string;
}

/**
 * Absorb a replica candidate's legacy edits (4.3) under its own epoch (`att.absorbKeys`), align
 * it to M's epoch when they differ, and preview its contribution against M. An alignment that
 * cannot proceed (newer, concurrent or legacy password change) throws KEY_MISMATCH; the caller
 * runs the key-epoch flows first.
 */
export function absorbReplicaCandidate(
  file: LoadedFile,
  m: SyncState,
  att: LegacyAttribution,
  meta: CandidateMeta,
  ctx: SyncContext,
  implicit: ImplicitProvider,
): ReplicaAbsorbResult {
  const captureImplicit = makeImplicitProvider(att.absorbKeys.kSync);
  const capture = captureLegacy({ state: file.state, content: file.content, cache: file.cache, implicit: captureImplicit }, att, ctx);
  const state = alignToM(capture.state, file.content, m, ctx);
  const merged = merge(m, state, implicit).state;
  const appDotsOnly = !hasLegacyChanges(capture) && uncoveredAreAppDots(state, m);
  const preview = replicaPreview({ m, cand: state, merged, implicit }, meta, appDotsOnly);
  return { state, capture, appDotsOnly, preview };
}

function alignToM(s1: SyncState, content: ContentSnapshot, m: SyncState, ctx: SyncContext): SyncState {
  if (currentEpochId(s1) === currentEpochId(m)) return s1;
  const sMeta: FileKeyMeta = {
    salt: content.meta.get(META_SALT_KEY) ?? null,
    verification: content.meta.get(META_VERIFICATION_KEY) ?? null,
  };
  const aligned = alignEpoch(s1, sMeta, m, ctx.keys);
  if (aligned.kind === 'proceed') return aligned.state;
  throw new SyncCoreError('KEY_MISMATCH', `replica candidate: key epoch ${aligned.kind}`);
}

function hasLegacyChanges(capture: CaptureResult): boolean {
  return capture.changed || capture.held.length > 0 || capture.contentRepairNeeded;
}

/**
 * Every explicit sibling of the candidate that M does not cover is an app sibling. Implicit
 * registers are skipped: they assert only catalog defaults of rows the candidate knows.
 */
function uncoveredAreAppDots(cand: SyncState, m: SyncState): boolean {
  for (const row of cand.rows.values()) {
    for (const reg of row.regs.values()) {
      for (const s of reg.sibs) {
        if (isPseudo(s) && !covered(m, reg.key, s)) return false;
      }
    }
  }
  return true;
}

// ---------- Preview ----------

interface PreviewInput {
  readonly m: SyncState;
  readonly cand: SyncState;
  readonly merged: SyncState;
  readonly implicit: ImplicitProvider;
}

interface PreviewLists {
  readonly changedFields: PreviewField[];
  readonly onlyInCopy: PreviewRow[];
  readonly deletions: PreviewRow[];
}

function replicaPreview(input: PreviewInput, meta: CandidateMeta, appDotsOnly: boolean): CandidatePreview {
  const lists: PreviewLists = { changedFields: [], onlyInCopy: [], deletions: [] };
  for (const [k, cRow] of input.cand.rows) {
    if (!isContentTbl(cRow.key.tbl)) continue;
    const mRow = input.m.rows.get(k);
    const mergedRow = input.merged.rows.get(k);
    if (!mergedRow || mergedRow === mRow) continue;
    previewRowChange(input, cRow, mRow, mergedRow, lists);
  }
  return {
    kind: 'replica',
    source: meta.source,
    label: meta.label,
    changedFields: lists.changedFields,
    onlyInCopy: lists.onlyInCopy,
    missingFromCopy: [],
    deletions: lists.deletions,
    needsReview: !appDotsOnly,
  };
}

function previewRowChange(
  input: PreviewInput,
  cRow: RowState,
  mRow: RowState | undefined,
  mergedRow: RowState,
  lists: PreviewLists,
): void {
  const key = cRow.key;
  const mLife = rowLife(input.m, key);
  if (mLife !== 'live') {
    if (isItemTbl(key.tbl) && rowLife(input.merged, key) === 'live') {
      lists.onlyInCopy.push(previewRow(key, rowTitle(input.merged, key)));
    }
    return;
  }
  if (isItemTbl(key.tbl) && bringsDelete(cRow, input.m)) lists.deletions.push(previewRow(key, rowTitle(input.m, key)));
  if (mRow) lists.changedFields.push(...changedFieldsOf(input, mRow, mergedRow));
}

/** The candidate holds a `dead` sibling of this row that M has not seen. */
function bringsDelete(cRow: RowState, m: SyncState): boolean {
  const reg = cRow.regs.get(LIFE_REG);
  if (!reg) return false;
  return reg.sibs.some((s) => s.value === LIFE_DEAD && isEligible(s) && !covered(m, reg.key, s));
}

/** Registers (except `_life`) whose merged provisional value differs from M's. */
function changedFieldsOf(input: PreviewInput, mRow: RowState, mergedRow: RowState): PreviewField[] {
  const out: PreviewField[] = [];
  const names = new Set([...mRow.regs.keys(), ...mergedRow.regs.keys()]);
  const title = rowTitle(input.m, mRow.key);
  for (const name of names) {
    if (name === LIFE_REG || mRow.regs.get(name) === mergedRow.regs.get(name)) continue;
    const key = regKeyOf(mRow.key, name);
    const before = provisionalView(input.m, key, input.implicit);
    const after = provisionalView(input.merged, key, input.implicit);
    if (before && after && before.vhash !== after.vhash) out.push(previewField(key, title, before.value, after.value));
  }
  return out;
}
