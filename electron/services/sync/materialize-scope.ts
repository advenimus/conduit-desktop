/**
 * Capture scope for materialization (spec 4.2 step 6, 4.6): after a per-operation capture
 * (capture-local.captureRows), only the rows it compared are known to be reflected in the
 * state. Any other content row whose stored bytes no longer match what the last materialize
 * recorded in sync_row was changed by a writer that skipped the hook (vault_meta writes,
 * importers, rekey, MCP). Materialize leaves such rows exactly as they are (no write, no
 * delete, cache entry unchanged), so the next full pass captures the change instead of
 * materialize silently reverting it. Part of materialize.ts.
 */

import { META_ROW_ID } from './catalog.js';
import { rawHash } from './hashing.js';
import { rowKeyStr } from './state-view.js';
import { TBL, type ContentRow, type ContentTbl, type RowCache, type RowCacheEntry, type RowKey } from './types.js';

export interface CaptureScope {
  /** The vault_meta row was compared; otherwise vault_meta is left untouched too. */
  readonly metaCaptured: boolean;
  /**
   * True when the content row (undefined = absent) must be left alone: the capture did not
   * compare it and it differs from the cache. `hash` returns rawHash of `cur` (memoized by the caller).
   */
  leaves(key: RowKey, cur: ContentRow | undefined, hash: () => string): boolean;
}

const META_KEY = rowKeyStr({ tbl: TBL.meta, rowId: META_ROW_ID });

/** null after a full pass (every row was compared); otherwise the scope of `captured`. */
export function captureScope(captured: readonly RowKey[] | undefined, cache: RowCache): CaptureScope | null {
  if (captured === undefined) return null;
  const inScope = new Set(captured.map(rowKeyStr));
  return {
    metaCaptured: inScope.has(META_KEY),
    leaves(key, cur, hash) {
      const k = rowKeyStr(key);
      return !inScope.has(k) && !matchesCache(cache.get(k), cur, hash);
    },
  };
}

/** The content row is what the last materialize left there (present with that hash, or absent). */
function matchesCache(entry: RowCacheEntry | undefined, cur: ContentRow | undefined, hash: () => string): boolean {
  if (cur === undefined) return entry?.materialized !== true;
  return entry?.materialized === true && entry.rawHash !== null && entry.rawHash === hash();
}

/** rawHash of a content row, computed at most once per row. */
export function lazyRawHash(tbl: ContentTbl, row: ContentRow | undefined): () => string {
  let memo: string | null = null;
  return () => {
    if (row === undefined) throw new Error('materialize: no content row to hash');
    memo ??= rawHash(tbl, row);
    return memo;
  };
}
