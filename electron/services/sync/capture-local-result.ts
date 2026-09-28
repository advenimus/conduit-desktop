/**
 * CaptureResult helpers shared by capture-local and capture-legacy: zero stats, the unchanged
 * result, deterministic notice ids and a mutable tally used while one capture runs.
 */

import { regKeyStr } from './state-view.js';
import type {
  CaptureResult,
  CaptureStats,
  HeldLegacyChange,
  LocalNotice,
  LocalNoticeKind,
  RegKey,
  RowKey,
  SyncState,
} from './types.js';

export const ZERO_STATS: CaptureStats = Object.freeze({
  appWrites: 0,
  legacyEdits: 0,
  legacyDeletes: 0,
  legacyDropped: 0,
  legacyHeld: 0,
  staleReverts: 0,
  undecryptable: 0,
});

const NO_ROWS: readonly RowKey[] = Object.freeze([]);
const NO_NOTICES: readonly LocalNotice[] = Object.freeze([]);
const NO_HELD: readonly HeldLegacyChange[] = Object.freeze([]);
const LOCAL_SOURCE = 'local';
const ANY_KEY = '*';

export function unchangedResult(state: SyncState): CaptureResult {
  return {
    state,
    changed: false,
    changedRows: NO_ROWS,
    notices: NO_NOTICES,
    held: NO_HELD,
    contentRepairNeeded: false,
    stats: ZERO_STATS,
  };
}

/**
 * A notice with an id derived from its kind, source and key, so absorbing the same bytes
 * twice produces the same notice (local.json dedupes by id).
 */
export function makeNotice(
  kind: LocalNoticeKind,
  key: RegKey | null,
  count: number,
  sourceSha256: string | null,
  createdMs: number,
): LocalNotice {
  const id = `${kind}:${sourceSha256 ?? LOCAL_SOURCE}:${key ? regKeyStr(key) : ANY_KEY}`;
  return { id, kind, key, createdMs, sourceSha256, count };
}

/** Counters and side outputs of one capture; a fresh object per call. */
export interface Tally {
  appWrites: number;
  legacyEdits: number;
  legacyDeletes: number;
  legacyDropped: number;
  legacyHeld: number;
  staleReverts: number;
  undecryptable: number;
  unrecoverable: number;
  contentRepairNeeded: boolean;
  readonly notices: LocalNotice[];
  readonly held: HeldLegacyChange[];
}

export function newTally(): Tally {
  return {
    appWrites: 0,
    legacyEdits: 0,
    legacyDeletes: 0,
    legacyDropped: 0,
    legacyHeld: 0,
    staleReverts: 0,
    undecryptable: 0,
    unrecoverable: 0,
    contentRepairNeeded: false,
    notices: [],
    held: [],
  };
}

export function statsOf(t: Tally): CaptureStats {
  return {
    appWrites: t.appWrites,
    legacyEdits: t.legacyEdits,
    legacyDeletes: t.legacyDeletes,
    legacyDropped: t.legacyDropped,
    legacyHeld: t.legacyHeld,
    staleReverts: t.staleReverts,
    undecryptable: t.undecryptable,
  };
}

export function buildResult(
  base: SyncState,
  state: SyncState,
  changedRows: readonly RowKey[],
  t: Tally,
): CaptureResult {
  return {
    state,
    changed: state !== base,
    changedRows,
    notices: [...t.notices],
    held: [...t.held],
    contentRepairNeeded: t.contentRepairNeeded,
    stats: statsOf(t),
  };
}
