/**
 * G3 genesis adoption (spec 4.4): when S has sync tables but another genesis_id, the shared
 * file's genesis wins. W's genesis-level registers (implicit, or holding only genesis pseudo
 * siblings) take S1's register; everything W did since its genesis merges normally; W's
 * pre-sync values are returned as leftovers for a synthetic candidate. Import through genesis.ts.
 */

import { fixedRegisters, isContentTbl, regKey } from './catalog.js';
import { GENESIS_MS } from './genesis-first.js';
import { merge } from './merge.js';
import { isRedacted, isValueUnknown } from './sibling.js';
import { headOf, provisional, rowKeyStr, rowLife } from './state-view.js';
import {
  PSEUDO_DEV,
  SIB_UNDECRYPTABLE,
  SyncCoreError,
  type CandidateRowValues,
  type CandidateRows,
  type CandidateValue,
  type ImplicitProvider,
  type MergeResult,
  type RegKey,
  type RegisterState,
  type RowState,
  type Sibling,
  type SyncState,
} from './types.js';

export interface AdoptResult {
  /**
   * M: per register, S1's register where W's is genesis-level, else mergeRegister(W, S1);
   * rows of S1 plus rows of W with any non-genesis-level register or a grave; everything
   * else merged as in merge(); genesisId = S1.genesisId.
   */
  readonly merged: MergeResult;
  /** W's genesis-level values of rows known in W, for candidates.buildSyntheticFromRows. */
  readonly leftovers: CandidateRows;
}

export function isGenesisSibling(s: Sibling): boolean {
  return s.dev === PSEUDO_DEV && s.ms === GENESIS_MS;
}

function isGenesisRegister(reg: RegisterState): boolean {
  return reg.sibs.every(isGenesisSibling);
}

/**
 * G3 "genesis-level" register of W: implicit, or explicit with every sibling a genesis pseudo
 * sibling (dev 0, ms 0). Such registers carry W's pre-sync version, not an edit. A register of
 * an unknown row carries nothing and is not genesis-level.
 */
export function isGenesisLevel(w: SyncState, key: RegKey): boolean {
  const row = w.rows.get(rowKeyStr(key));
  if (!row) return false;
  const reg = row.regs.get(key.reg);
  return reg === undefined || isGenesisRegister(reg);
}

/**
 * G3: the shared file's genesis always wins; W's differing pre-sync values become a candidate.
 * Precondition: s1 is under W's current key epoch (alignEpoch ran), as for merge().
 */
export function adoptGenesis(w: SyncState, s1: SyncState, implicit: ImplicitProvider): AdoptResult {
  if (w.lineageId !== s1.lineageId) {
    throw new SyncCoreError('MERGE_PRECONDITION', 'adoptGenesis: lineage ids differ');
  }
  const merged = merge(adjustW(w, s1), s1, implicit);
  return { merged, leftovers: genesisLeftovers(w, implicit) };
}

/**
 * W with S1's genesis id, genesis-only rows replaced by S1's rows (or dropped when S1 lacks
 * them) and every genesis-level register of the remaining rows S1 knows replaced by S1's
 * register (implicit when S1 has none), so merge(adjusted, S1) keeps S1's register there.
 * A row S1 does not know keeps W's genesis-level registers: they conflict with nothing in
 * S1, and making them implicit would reset every pre-sync field of a row W edited since.
 */
function adjustW(w: SyncState, s1: SyncState): SyncState {
  const rows = new Map(w.rows);
  for (const [k, wRow] of w.rows) {
    const next = adoptRow(wRow, s1.rows.get(k));
    if (next === null) rows.delete(k);
    else if (next !== wRow) rows.set(k, next);
  }
  return { ...w, genesisId: s1.genesisId, rows };
}

function adoptRow(wRow: RowState, sRow: RowState | undefined): RowState | null {
  if (isGenesisOnlyRow(wRow)) return sRow ?? null;
  if (sRow === undefined) return wRow;
  const regs = new Map(wRow.regs);
  let changed = false;
  for (const [name, reg] of wRow.regs) {
    if (!isGenesisRegister(reg)) continue;
    const sReg = sRow.regs.get(name);
    if (sReg) regs.set(name, sReg);
    else regs.delete(name);
    changed = true;
  }
  for (const [name, sReg] of sRow.regs) {
    if (wRow.regs.has(name)) continue;
    regs.set(name, sReg);
    changed = true;
  }
  return changed ? { key: wRow.key, regs, grave: wRow.grave } : wRow;
}

function isGenesisOnlyRow(row: RowState): boolean {
  if (row.grave !== null) return false;
  for (const reg of row.regs.values()) {
    if (!isGenesisRegister(reg)) return false;
  }
  return true;
}

// ---------- Leftovers ----------

/**
 * Genesis-level values of W's live content rows: explicit genesis siblings' values and the
 * defaults of implicit fixed registers. Rows W deleted are not offered (that would undo W's
 * own delete). rowTimeMs = max lt of the row's genesis siblings.
 */
function genesisLeftovers(w: SyncState, implicit: ImplicitProvider): CandidateRows {
  const out = new Map<string, CandidateRowValues>();
  for (const [k, row] of w.rows) {
    if (!isContentTbl(row.key.tbl) || rowLife(w, row.key) !== 'live') continue;
    const values = leftoverRow(row, implicit);
    if (values) out.set(k, values);
  }
  return out;
}

function leftoverRow(row: RowState, implicit: ImplicitProvider): CandidateRowValues | null {
  const values = new Map<string, CandidateValue>();
  let rowTimeMs = 0;
  for (const def of fixedRegisters(row.key.tbl)) {
    if (row.regs.has(def.reg)) continue;
    const s = implicit(regKey(row.key.tbl, row.key.rowId, def.reg));
    values.set(def.reg, { value: s.value, vhash: s.vhash, flags: 0 });
  }
  for (const [name, reg] of row.regs) {
    if (!isGenesisRegister(reg)) continue;
    const v = genesisCandidateValue(reg);
    if (v) values.set(name, v);
    for (const s of reg.sibs) rowTimeMs = Math.max(rowTimeMs, s.lt);
  }
  return values.size === 0 ? null : { row: row.key, rowTimeMs, values };
}

function genesisCandidateValue(reg: RegisterState): CandidateValue | null {
  const s = provisional(reg.key.reg, reg.sibs) ?? headOf(reg.key.reg, reg.sibs);
  if (!s || isRedacted(s) || isValueUnknown(s)) return null;
  return { value: s.value, vhash: s.vhash, flags: s.flags & SIB_UNDECRYPTABLE };
}
