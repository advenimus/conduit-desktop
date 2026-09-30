/**
 * Capture of local edits (spec 4.2): the row pass (raw_hash skip, per-register compare),
 * inserts, deletes with cascade rule H, re-assertion rule R, interactive versus
 * non-interactive replacement, prev_vhash, and direct register writes (resolutions, restores,
 * presence publish marker, owner claim). Used for W after app mutations and for the full pass
 * before every merge and publish. Pure: returns a new state, never touches SQL.
 *
 * Parts: capture-local-observe (hashing content values, expected-value test),
 * capture-local-diff (row pass), capture-local-write (writer, rule R, rule H),
 * capture-local-apply (local attribution), capture-local-explicit (prepared writes).
 */

import { applyLocalDiffs } from './capture-local-apply.js';
import { diffFull, diffRows } from './capture-local-diff.js';
import { localSecretKeys } from './capture-local-observe.js';
import type {
  CaptureResult,
  ContentSnapshot,
  ImplicitProvider,
  LocalAttribution,
  RowCache,
  RowKey,
  SyncContext,
  SyncState,
} from './types.js';

export {
  applyLocalWrites,
  ownerClaimWrite,
  ownerTagWrite,
  prepareWrite,
  presenceWrite,
  type ApplyWritesOptions,
  type WriteInput,
} from './capture-local-explicit.js';

export interface CaptureInput {
  readonly state: SyncState;
  readonly content: ContentSnapshot;
  readonly cache: RowCache;
  readonly implicit: ImplicitProvider;
}

/** Full pass over every content row, every materialized row (deletes) and vault_meta (4.2 step 6). */
export function captureFullPass(input: CaptureInput, att: LocalAttribution, ctx: SyncContext): CaptureResult {
  const keys = localSecretKeys(ctx);
  return applyLocalDiffs(input, diffFull(input, { keys }), att, ctx, keys);
}

/**
 * Per-operation capture: the same comparison restricted to `rows` (the rows a mutator touched,
 * including rows it deleted). `input.content` needs only those rows (state-store.loadContentRows).
 * vault_meta is compared only when `rows` lists the meta row. The result's `scope` lists `rows`:
 * materialize must receive it as `capturedRows`, or it would overwrite rows that writers which
 * skipped the hook changed since the last full pass (4.2 step 6).
 */
export function captureRows(
  input: CaptureInput,
  rows: readonly RowKey[],
  att: LocalAttribution,
  ctx: SyncContext,
): CaptureResult {
  const keys = localSecretKeys(ctx);
  const res = applyLocalDiffs(input, diffRows(input, rows, { keys }), att, ctx, keys);
  return { ...res, scope: [...rows] };
}
