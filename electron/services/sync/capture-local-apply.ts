/**
 * Local attribution of a row pass (spec 4.2 steps 2-5): one app dot for the whole operation,
 * one new app sibling per changed register (replace-all when interactive, else
 * replace-provisional), `_life` for inserts, resurrections and deletes, cascade rule H and
 * rule R re-assertions.
 */

import { LIFE_DEAD, LIFE_LIVE, isContentTbl } from './catalog.js';
import type { Diffs, RowDiff } from './capture-local-diff.js';
import { resealStaleValues, sealValue, type SecretKeys } from './capture-local-observe.js';
import { buildResult, makeNotice, newTally, unchangedResult, type Tally } from './capture-local-result.js';
import { AppWriter, applyAppRuleR, historyDeleteRecorded, type RuleHContext } from './capture-local-write.js';
import { rowKeyStr } from './state-view.js';
import {
  SIB_UNDECRYPTABLE,
  TBL,
  type CaptureResult,
  type ImplicitProvider,
  type LocalAttribution,
  type RowCache,
  type RowKey,
  type SyncContext,
  type SyncState,
  type WriteMode,
} from './types.js';

export interface LocalApplyInput {
  readonly state: SyncState;
  readonly cache: RowCache;
  readonly implicit: ImplicitProvider;
}

export function modeOf(att: Pick<LocalAttribution, 'interactive'>): WriteMode {
  return att.interactive ? 'replace-all' : 'replace-provisional';
}

export function applyLocalDiffs(
  input: LocalApplyInput,
  diffs: Diffs,
  att: LocalAttribution,
  ctx: SyncContext,
  keys: SecretKeys,
): CaptureResult {
  if (diffs.rows.length === 0 && diffs.deletes.length === 0 && diffs.reseals.length === 0) {
    return noDots(input.state, diffs.base);
  }
  const w = new AppWriter(diffs.base, att.dot, input.implicit);
  const mode = modeOf(att);
  const tally = newTally();
  const lived = new Set<string>();
  for (const d of diffs.rows) writeRowDiff(w, d, mode, keys, ctx, tally, lived);
  writeDeletes(w, { ...input, state: diffs.base }, diffs.deletes, mode, lived);
  applyAppRuleR(w, liveSources(diffs.rows));
  resealStaleValues(w.builder, diffs.reseals, keys, ctx);
  tally.appWrites = w.count;
  if (tally.undecryptable > 0) {
    tally.notices.push(makeNotice('undecryptable-secrets', null, tally.undecryptable, null, ctx.now()));
  }
  const { state, changedRows } = w.finish(ctx);
  return buildResult(input.state, state, changedRows, tally);
}

/** A capture that found nothing to attribute; `base` differs only by restored `_life` values. */
export function noDots(input: SyncState, base: SyncState): CaptureResult {
  const res = unchangedResult(base);
  return base === input ? res : { ...res, changed: true };
}

function writeRowDiff(
  w: AppWriter,
  d: RowDiff,
  mode: WriteMode,
  keys: SecretKeys,
  ctx: SyncContext,
  tally: Tally,
  lived: Set<string>,
): void {
  if (d.kind === 'insert' || d.kind === 'resurrect') {
    w.writeLife(d.row, LIFE_LIVE, mode);
    lived.add(rowKeyStr(d.row));
  }
  for (const c of d.changes) {
    w.write(c.key, sealValue(c.obs, keys, ctx), c.obs.vhash, c.obs.flags, mode);
    if ((c.obs.flags & SIB_UNDECRYPTABLE) !== 0) tally.undecryptable++;
  }
}

/** Entries and folders first, so rule H sees every entry that died in this capture. */
function writeDeletes(
  w: AppWriter,
  input: LocalApplyInput,
  deletes: readonly RowKey[],
  mode: WriteMode,
  lived: ReadonlySet<string>,
): void {
  const died = new Set<string>();
  for (const row of deletes) {
    if (row.tbl === TBL.history) continue;
    w.writeLife(row, LIFE_DEAD, mode);
    died.add(rowKeyStr(row));
  }
  const ruleH: RuleHContext = { state: input.state, cache: input.cache, diedNow: died, livedNow: lived };
  for (const row of deletes) {
    if (row.tbl === TBL.history && historyDeleteRecorded(ruleH, row)) w.writeLife(row, LIFE_DEAD, mode);
  }
}

function liveSources(rows: readonly RowDiff[]): RowKey[] {
  return rows.filter((d) => isContentTbl(d.row.tbl)).map((d) => d.row);
}
