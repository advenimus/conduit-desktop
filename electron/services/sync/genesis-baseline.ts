/**
 * G2 baseline absorb (spec 4.4): a pre-sync S written over the shared file after this device's
 * genesis is absorbed against the kept baseline (genesis.conduit), with the staleness filter.
 * Import through genesis.ts.
 */

import { captureLegacy } from './capture-legacy.js';
import { parseLegacyTime } from './canonical.js';
import { isContentTbl } from './catalog.js';
import { makeImplicitProvider } from './hashing.js';
import { verifyKey } from './key-epoch.js';
import { contentRowTime, contentTable, genesisFromContent } from './genesis-first.js';
import { findSibling } from './state-view.js';
import {
  SyncCoreError,
  TBL,
  type CaptureResult,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type EntryRow,
  type EpochKeys,
  type FolderRow,
  type LegacyAttribution,
  type LegacyFilter,
  type RowKey,
  type SyncContext,
  type SyncState,
  type ValueRecovery,
} from './types.js';

const META_VERIFICATION_KEY = 'verification';

export interface BaselineAbsorbInput {
  readonly w: SyncState;
  /** Content of genesis.conduit; its SHA-256 must equal w.genesisId (checked by the caller). */
  readonly baseline: ContentSnapshot;
  readonly s: ContentSnapshot;
  readonly sMtimeMs: number;
  readonly sSha256: string;
  /** Keys of S's epoch (G2 step 1 found them). */
  readonly sKeys: EpochKeys;
  readonly sideFilesPresent: boolean;
  readonly serverSideFilesFlagRecent: boolean;
}

/**
 * G2 step 2: X = genesis(baseline), capture(X, Legacy(S)) with the staleness filter. Merge with
 * W is the caller's. Throws KEY_MISMATCH when the baseline is not under S's epoch; the caller
 * then treats S as a synthetic candidate (G2 step 3).
 */
export function baselineAbsorb(input: BaselineAbsorbInput, ctx: SyncContext): CaptureResult {
  const keys = checkBaselineKeys(input);
  const x = genesisFromContent({
    content: input.baseline,
    genesisId: input.w.genesisId,
    lineageId: input.w.lineageId,
    k0: keys,
    ring: ctx.keys,
    randomBytes: ctx.randomBytes,
    now: ctx.now,
  });
  const att: LegacyAttribution = {
    kind: 'legacy',
    observedMtimeMs: input.sMtimeMs,
    sideFilesPresent: input.sideFilesPresent,
    serverSideFilesFlagRecent: input.serverSideFilesFlagRecent,
    absorbKeys: keys,
    sourceSha256: input.sSha256,
    filter: stalenessFilter(input.baseline, input.s),
    recover: recoverFromEither(x.state, input.w),
  };
  const implicit = makeImplicitProvider(keys.kSync);
  return captureLegacy({ state: x.state, content: input.s, cache: x.cache, implicit }, att, ctx);
}

/**
 * The baseline must be under S's epoch: genesis pids are keyed with that epoch's K_pid, so a
 * different key would mint genesis siblings that do not match W's.
 */
function checkBaselineKeys(input: BaselineAbsorbInput): EpochKeys {
  const keys = input.sKeys;
  const baselineToken = input.baseline.meta.get(META_VERIFICATION_KEY);
  if (!baselineToken || baselineToken === input.s.meta.get(META_VERIFICATION_KEY)) return keys;
  if (!verifyKey(keys.kEpoch, baselineToken)) {
    throw new SyncCoreError('KEY_MISMATCH', 'baseline and S are under different key epochs');
  }
  return keys;
}

/**
 * skipRow: S's row time is older than the same row in the baseline (S predates the baseline).
 * allowDelete: a baseline row missing from S counts as deleted only when the newest updated_at
 * in S is at or after that row's baseline created_at.
 */
export function stalenessFilter(baseline: ContentSnapshot, s: ContentSnapshot): LegacyFilter {
  const newestS = newestUpdatedAt(s);
  return {
    skipRow: (row: RowKey, content: ContentRow): boolean => {
      if (!isContentTbl(row.tbl)) return false;
      const g = contentTable(baseline, row.tbl).get(row.rowId);
      return g !== undefined && contentRowTime(row.tbl, content) < contentRowTime(row.tbl, g);
    },
    allowDelete: (row: RowKey): boolean => {
      if (!isContentTbl(row.tbl)) return true;
      const g = contentTable(baseline, row.tbl).get(row.rowId);
      return g !== undefined && newestS >= createdTime(row.tbl, g);
    },
  };
}

function newestUpdatedAt(content: ContentSnapshot): number {
  let newest = 0;
  for (const row of content.entries.values()) newest = Math.max(newest, parseLegacyTime(row.updated_at));
  for (const row of content.folders.values()) newest = Math.max(newest, parseLegacyTime(row.updated_at));
  return newest;
}

function createdTime(tbl: ContentTbl, row: ContentRow): number {
  if (tbl === TBL.history) return contentRowTime(tbl, row);
  return parseLegacyTime((row as EntryRow | FolderRow).created_at);
}

/** X carries the baseline's values; W is the fallback for identities X no longer has. */
function recoverFromEither(x: SyncState, w: SyncState): ValueRecovery {
  return (key, identity) => {
    const own = findSibling(x, key, identity);
    if (own) return own.value;
    return findSibling(w, key, identity)?.value;
  };
}
