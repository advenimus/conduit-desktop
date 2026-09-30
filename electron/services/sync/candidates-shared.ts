/**
 * Helpers shared by replica and synthetic candidates (spec 4.9): provisional values with
 * defaults, row titles and preview entries. Import through candidates.ts.
 */

import { asText, registerDef, registerLabel, regKey } from './catalog.js';
import { provisional, rowKeyStr } from './state-view.js';
import { TBL, type ImplicitProvider, type PreviewField, type PreviewRow, type RegKey, type RowKey, type SyncState, type SyncValue } from './types.js';

const NAME_REG = 'name';

/** Tables whose rows are user-visible items (history rows follow their entry). */
export function isItemTbl(tbl: number): boolean {
  return tbl === TBL.entries || tbl === TBL.folders;
}

export interface ProvisionalView {
  readonly value: SyncValue;
  readonly vhash: string;
}

/**
 * M's provisional value of a register as materialize sees it: the provisional sibling, or the
 * catalog default when the register is implicit or has no eligible sibling. null for unknown rows.
 */
export function provisionalView(state: SyncState, key: RegKey, implicit: ImplicitProvider): ProvisionalView | null {
  const row = state.rows.get(rowKeyStr(key));
  if (!row) return null;
  const reg = row.regs.get(key.reg);
  const p = reg ? provisional(key.reg, reg.sibs) : null;
  return p ?? implicit(key);
}

export function rowTitle(state: SyncState, row: RowKey): string {
  const reg = state.rows.get(rowKeyStr(row))?.regs.get(NAME_REG);
  const p = reg ? provisional(NAME_REG, reg.sibs) : null;
  return p ? asText(p.value) ?? '' : '';
}

export function previewRow(row: RowKey, title: string): PreviewRow {
  return { row, title };
}

/** A changed field; secrets are masked (both values null). */
export function previewField(key: RegKey, rowTitleText: string, current: SyncValue, incoming: SyncValue): PreviewField {
  const masked = registerDef(key)?.secret ?? false;
  return {
    key,
    label: registerLabel(key),
    rowTitle: rowTitleText,
    current: masked ? null : current,
    incoming: masked ? null : incoming,
    masked,
  };
}

export function regKeyOf(row: RowKey, reg: string): RegKey {
  return regKey(row.tbl, row.rowId, reg);
}

export function compareRowKeys(a: RowKey, b: RowKey): number {
  const ka = rowKeyStr(a);
  const kb = rowKeyStr(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
