/**
 * The per-change rules of legacy capture (spec 4.3): pseudo edit and delete times, the drop
 * rule for rebuilt config, and the stale-revert test.
 */

import { parseLegacyTime } from './canonical.js';
import { isDocumentContent, isEmptyConfigValue, registerDef } from './catalog.js';
import { prevOf, vhashOfSecret, vhashOfValue } from './hashing.js';
import { isEligible } from './sibling.js';
import {
  FUTURE_CAP_MS,
  PSEUDO_DEV,
  TBL,
  type ContentRow,
  type EntryRow,
  type HistoryRow,
  type KeyRing,
  type RegKey,
  type Sibling,
  type SqlValue,
  type SyncValue,
  type Tbl,
} from './types.js';

export interface LegacyTime {
  readonly ms: number;
  readonly lt: number;
}

/** pmem ms of an empty memory, so the first pseudo sibling may carry ms 0. */
const NO_PMEM_MS = -1;

/** The JSON forms an older app writes when it rebuilds `config` from scratch (4.3 rule 1). */
const EMPTY_CONFIG_FORMS: readonly SyncValue[] = [null, '[]', '{}', '""'];

/** Edit time (4.3): lt = parseLegacyTime(updated_at); ms = max(lt, pmemMs + 1) (pmemMs -1 when no memory). */
export function legacyEditTime(updatedAt: SqlValue, pmemMs: number | null): LegacyTime {
  const lt = parseLegacyTime(updatedAt);
  return { ms: Math.max(lt, (pmemMs ?? NO_PMEM_MS) + 1), lt };
}

/** Delete and rowless time (4.3): ms = lt = max(pmemMs + 1, min(observedMtimeMs, nowMs + 24 h)). */
export function legacyDeleteTime(pmemMs: number | null, observedMtimeMs: number, nowMs: number): number {
  return Math.max((pmemMs ?? NO_PMEM_MS) + 1, Math.min(observedMtimeMs, nowMs + FUTURE_CAP_MS));
}

/** The column a content row's edit time comes from: history uses changed_at, others updated_at. */
export function rowTimeValue(tbl: Tbl, row: ContentRow): SqlValue {
  return tbl === TBL.history ? (row as HistoryRow).changed_at : (row as EntryRow).updated_at;
}

/**
 * w's value may have been read from the content the legacy app just changed, so emptiness
 * is judged by its vhash, which always describes its real value.
 */
function holdsNonEmptyConfig(key: RegKey, w: Sibling | null): boolean {
  if (w === null || !isEligible(w)) return false;
  return !EMPTY_CONFIG_FORMS.some((form) => vhashOfValue(key, form) === w.vhash);
}

/** Drop rule (4.3 rule 1). `entryType` is the row's provisional entry_type in X. */
export function isDroppedChange(key: RegKey, newValue: SyncValue, w: Sibling | null, entryType: SyncValue): boolean {
  const def = registerDef(key);
  if (def === null || def.family !== 'config' || !isEmptyConfigValue(newValue)) return false;
  if (isDocumentContent(key, entryType)) return true;
  return holdsNonEmptyConfig(key, w);
}

/**
 * Stale-revert rule (4.3 rule 3): w is an app sibling and prev(w) == first 8 bytes of vhash(v).
 * `rekeyedPrevs` adds the prev forms of a secret's new value under older epochs' K_sync.
 */
export function isStaleRevert(w: Sibling | null, newVhash: string, rekeyedPrevs?: ReadonlySet<string>): boolean {
  if (w === null || w.dev === PSEUDO_DEV || w.prevVhash === null) return false;
  return w.prevVhash === prevOf(newVhash) || (rekeyedPrevs?.has(w.prevVhash) ?? false);
}

/**
 * A secret's prev_vhash keeps the K_sync in force when it was written, while re-encryption
 * (4.8 step 3) re-keys only vhashes. So the new value's plaintext is hashed under every epoch
 * of the ring to recognize a revert written before a password change.
 */
export function secretRevertPrevs(key: RegKey, plaintext: string | null, ring: KeyRing): ReadonlySet<string> {
  const out = new Set<string>();
  for (const keys of ring.byEpoch.values()) out.add(prevOf(vhashOfSecret(key, plaintext, keys.kSync)));
  return out;
}
