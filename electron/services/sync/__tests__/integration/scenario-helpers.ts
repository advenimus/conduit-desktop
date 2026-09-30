// Small readers shared by the scenario tests: conflict summaries, provisional values and
// file-level views of S, so assertions talk about what a user or an older app would see.
import fs from 'node:fs';
import { getRegister, provisional } from '../../state-view.js';
import { TBL, type ConflictGroup, type ConflictItem, type FieldConflict, type RegKey, type SyncState, type SyncValue } from '../../types.js';
import { sha256 } from './fake-cloud.js';

/** Per-test budget: real SQLite, VACUUM INTO and fs work run in parallel workers. */
export const SCENARIO_TIMEOUT_MS = 30_000;

export interface ConflictLine {
  readonly row: string;
  readonly kind: ConflictItem['kind'];
  readonly reg: string | null;
}

export function conflictLines(groups: readonly ConflictGroup[]): ConflictLine[] {
  const out: ConflictLine[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      const reg = item.kind === 'field' || item.kind === 'undecryptable' ? item.field.key.reg : null;
      out.push({ row: g.row.rowId, kind: item.kind, reg });
    }
  }
  return out.sort((a, b) => `${a.row}${a.kind}${a.reg}`.localeCompare(`${b.row}${b.kind}${b.reg}`));
}

export function fieldConflict(groups: readonly ConflictGroup[], rowId: string, reg: string): FieldConflict | null {
  for (const g of groups) {
    if (g.row.rowId !== rowId) continue;
    for (const item of g.items) if ((item.kind === 'field' || item.kind === 'undecryptable') && item.field.key.reg === reg) return item.field;
  }
  return null;
}

export function itemOf<K extends ConflictItem['kind']>(groups: readonly ConflictGroup[], rowId: string, kind: K): Extract<ConflictItem, { kind: K }> | null {
  for (const g of groups) {
    for (const item of g.items) {
      if (item.kind !== kind) continue;
      if (g.row.rowId === rowId || (item.kind === 'cycle' && item.rowIds.includes(rowId))) return item as Extract<ConflictItem, { kind: K }>;
    }
  }
  return null;
}

export const entryReg = (rowId: string, reg: string): RegKey => ({ tbl: TBL.entries, rowId, reg });

/** Provisional value of a register (undefined when the register is empty or implicit). */
export function prov(state: SyncState, key: RegKey): SyncValue | undefined {
  const r = getRegister(state, key);
  if (r === undefined) return undefined;
  return provisional(key.reg, r.sibs)?.value;
}

export function fileSha(file: string): string {
  return sha256(fs.readFileSync(file));
}

