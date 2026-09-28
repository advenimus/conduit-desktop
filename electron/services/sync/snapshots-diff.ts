/**
 * Pure diff of W before a merge and M after it (spec 5.10): the entries and folders the merge
 * deleted, with their provisional values, and the fields it changed on rows live on both
 * sides. Values are value-codec encoded; secrets stay ciphertext. Import through snapshots.ts.
 */

import { compareRowKeys, isItemTbl, rowTitle } from './candidates-shared.js';
import { LIFE_REG, registerDef } from './catalog.js';
import { isPseudo } from './sibling.js';
import { getRegister, provisional, regKeyStr, rowLife } from './state-view.js';
import { encodeValue, type EncodedValue } from './value-codec.js';
import {
  MASS_CHANGE_MIN_ROWS,
  MASS_CHANGE_RATIO,
  MASS_DELETE_MIN_ROWS,
  type ChangedFieldRecord,
  type DeletedRowRecord,
  type MergeDiff,
} from './snapshots-types.js';
import type { ImplicitProvider, RegisterState, RegKey, RowKey, RowState, Sibling, SyncState } from './types.js';

/** Marks a delete that no single app device made (a legacy pseudo dot, or a row M dropped). */
const UNKNOWN_DELETER = '';

/** Pure diff of W before and M after (entries and folders; history follows its entry). */
export function diffMerge(before: SyncState, after: SyncState, implicit: ImplicitProvider): MergeDiff {
  let liveBefore = 0;
  const deleted: DeletedRowRecord[] = [];
  const changed: ChangedFieldRecord[] = [];
  const changedRowKeys = new Set<string>();
  const deleters = new Set<string>();
  for (const [k, rowB] of before.rows) {
    if (!isItemTbl(rowB.key.tbl) || rowLife(before, rowB.key) !== 'live') continue;
    liveBefore++;
    const rowA = after.rows.get(k);
    if (rowA === rowB) continue;
    if (rowA === undefined || rowLife(after, rowB.key) !== 'live') {
      deleted.push(deletedRecord(before, rowB));
      deleters.add(deleterOf(after, rowB.key));
      continue;
    }
    const fields = changedFields(rowB, rowA, implicit);
    if (fields.length > 0) changedRowKeys.add(k);
    changed.push(...fields);
  }
  return {
    liveBefore,
    deleted: deleted.sort((a, b) => compareRowKeys(a.row, b.row)),
    changed: changed.sort(compareChanged),
    changedRows: changedRowKeys.size,
    byDeviceUuid: singleDeleter(deleters),
  };
}

/** deleted >= MASS_DELETE_MIN_ROWS, or changedRows >= max(MASS_CHANGE_MIN_ROWS, ceil(MASS_CHANGE_RATIO * liveBefore)). */
export function isMassChange(diff: MergeDiff): boolean {
  if (diff.deleted.length >= MASS_DELETE_MIN_ROWS) return true;
  const threshold = Math.max(MASS_CHANGE_MIN_ROWS, Math.ceil(MASS_CHANGE_RATIO * diff.liveBefore));
  return diff.changedRows >= threshold;
}

function deletedRecord(before: SyncState, row: RowState): DeletedRowRecord {
  const values: Array<readonly [string, EncodedValue]> = [];
  for (const [name, reg] of row.regs) {
    if (name === LIFE_REG || registerDef(reg.key) === null) continue;
    const p = provisional(name, reg.sibs);
    if (p !== null) values.push([name, encodeValue(p.value)]);
  }
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { row: { tbl: row.key.tbl, rowId: row.key.rowId }, title: rowTitle(before, row.key), values: Object.fromEntries(values) };
}

/** The device whose app dot deleted the row in M, or UNKNOWN_DELETER. */
function deleterOf(after: SyncState, row: RowKey): string {
  const reg = getRegister(after, { tbl: row.tbl, rowId: row.rowId, reg: LIFE_REG });
  const dead = reg ? provisional(LIFE_REG, reg.sibs) : null;
  if (dead === null || isPseudo(dead)) return UNKNOWN_DELETER;
  return after.devs.get(dead.dev)?.deviceUuid ?? UNKNOWN_DELETER;
}

function singleDeleter(deleters: ReadonlySet<string>): string | null {
  if (deleters.size !== 1) return null;
  const [only] = deleters;
  return only === UNKNOWN_DELETER ? null : only;
}

function changedFields(rowB: RowState, rowA: RowState, implicit: ImplicitProvider): ChangedFieldRecord[] {
  const out: ChangedFieldRecord[] = [];
  for (const name of new Set([...rowB.regs.keys(), ...rowA.regs.keys()])) {
    if (name === LIFE_REG) continue;
    const regB = rowB.regs.get(name);
    const regA = rowA.regs.get(name);
    if (regB === regA) continue;
    const key = (regB ?? (regA as RegisterState)).key;
    const def = registerDef(key);
    if (def === null) continue;
    const pB = viewOf(regB, key, implicit);
    const pA = viewOf(regA, key, implicit);
    if (pB === null || pA === null || pB.vhash === pA.vhash) continue;
    out.push({ key: { tbl: key.tbl, rowId: key.rowId, reg: key.reg }, before: encodeValue(pB.value), after: encodeValue(pA.value), secret: def.secret });
  }
  return out;
}

/** Provisional sibling of an explicit register, the implicit sibling otherwise; null when none is eligible. */
function viewOf(reg: RegisterState | undefined, key: RegKey, implicit: ImplicitProvider): Sibling | null {
  return reg ? provisional(key.reg, reg.sibs) : implicit(key);
}

function compareChanged(a: ChangedFieldRecord, b: ChangedFieldRecord): number {
  const byRow = compareRowKeys(a.key, b.key);
  if (byRow !== 0) return byRow;
  const ka = regKeyStr(a.key);
  const kb = regKeyStr(b.key);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
