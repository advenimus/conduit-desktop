/**
 * Deletes and tombstones (spec 4.7): the Recently deleted list from rows whose provisional
 * `_life` is dead, restore as an interactive `live` write, and "Delete permanently" as a
 * redaction (not a dot) that erases values but keeps dots and pseudo memory so coverage and
 * merge still work. No time-based purge exists in format 1.
 */

import { prepareWrite } from './capture-local.js';
import { LIFE_DEAD, LIFE_LIVE, LIFE_REG, asText, fixedDef, isContentTbl, regKey } from './catalog.js';
import { compareNum, compareStr, isRedacted } from './sibling.js';
import { StateBuilder, provisional, rowKeyStr } from './state-view.js';
import {
  SIB_REDACTED,
  TBL,
  ZERO_VHASH,
  type DeletedItem,
  type Grave,
  type LocalWrite,
  type RegisterDef,
  type RowKey,
  type RowState,
  type Sibling,
  type SyncContext,
  type SyncState,
} from './types.js';

export const RECENTLY_DELETED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const NAME_REG = 'name';
const ENTRY_TYPE_REG = 'entry_type';
const HISTORY_ENTRY_REG = 'entry_id';

/** Dead entries and folders (not history), newest first; last 30 days unless showAll. */
export function listRecentlyDeleted(state: SyncState, nowMs: number, showAll: boolean): DeletedItem[] {
  const cutoff = nowMs - RECENTLY_DELETED_WINDOW_MS;
  const out: DeletedItem[] = [];
  for (const row of state.rows.values()) {
    if (row.key.tbl !== TBL.entries && row.key.tbl !== TBL.folders) continue;
    const dead = deadSibling(row);
    if (dead === null) continue;
    const diedMs = row.grave?.diedMs ?? dead.ms;
    if (!showAll && diedMs < cutoff) continue;
    out.push({
      row: row.key,
      title: textValue(row, fixedDef(row.key.tbl, NAME_REG)) ?? '',
      entryType: row.key.tbl === TBL.entries ? textValue(row, fixedDef(TBL.entries, ENTRY_TYPE_REG)) : null,
      diedMs,
      diedDev: row.grave?.diedDev ?? dead.dev,
      redacted: row.grave?.redacted ?? false,
    });
  }
  return out.sort(newestFirst);
}

/**
 * Restore (4.7): an interactive write of `live` with the grave's values. Per restored row: a
 * replace-all `_life = live` write, then one write per explicit register copying its
 * provisional value under the new dot, so a concurrent "Delete permanently" (which redacts only
 * identities it has seen) cannot erase the item the user just restored. A restored entry's live
 * password_history rows (hidden while it was dead, and redacted with it) get the same value
 * writes. Value writes replace only the provisional sibling, so an open conflict on the item
 * stays open. Registers without a provisional value (redacted, undecryptable or value-unknown
 * only) are left as they are. Rule R then re-asserts the container chain and the history rows.
 * Rows that are unknown or not dead are skipped; duplicates count once.
 */
export function restoreWrites(state: SyncState, rows: readonly RowKey[], ctx: SyncContext): LocalWrite[] {
  const writes: LocalWrite[] = [];
  const seen = new Set<string>();
  let history: ReadonlyMap<string, readonly RowState[]> | null = null;
  for (const key of rows) {
    const k = rowKeyStr(key);
    const row = state.rows.get(k);
    if (seen.has(k) || !row || !isContentTbl(row.key.tbl) || deadSibling(row) === null) continue;
    seen.add(k);
    writes.push(prepareWrite(regKey(key.tbl, key.rowId, LIFE_REG), { value: LIFE_LIVE }, ctx, 'replace-all'));
    writes.push(...restoredValues(row, ctx));
    if (row.key.tbl !== TBL.entries) continue;
    history ??= liveHistoryByEntry(state);
    for (const h of history.get(row.key.rowId) ?? []) writes.push(...restoredValues(h, ctx));
  }
  return writes;
}

/** Live password_history rows by the entry their provisional entry_id names. */
function liveHistoryByEntry(state: SyncState): ReadonlyMap<string, readonly RowState[]> {
  const out = new Map<string, RowState[]>();
  for (const row of state.rows.values()) {
    if (row.key.tbl !== TBL.history || !isLive(row)) continue;
    const reg = row.regs.get(HISTORY_ENTRY_REG);
    const entryId = reg ? asText(provisional(HISTORY_ENTRY_REG, reg.sibs)?.value ?? null) : null;
    if (entryId === null) continue;
    const list = out.get(entryId);
    if (list) list.push(row);
    else out.set(entryId, [row]);
  }
  return out;
}

const RESTORED_VALUE_MODE = 'replace-provisional';

function restoredValues(row: RowState, ctx: SyncContext): LocalWrite[] {
  const out: LocalWrite[] = [];
  for (const [name, reg] of row.regs) {
    if (name === LIFE_REG) continue;
    const p = provisional(name, reg.sibs);
    if (p !== null) out.push(prepareWrite(reg.key, { sibling: p }, ctx, RESTORED_VALUE_MODE));
  }
  return out;
}

/**
 * Redacts every register of each dead row except `_life`, plus every password_history row
 * whose provisional or any sibling `entry_id` names a listed entry, and marks graves redacted.
 * Not a dot: vv, dots and pseudo memory stay. Live and unknown rows are never redacted.
 */
export function deletePermanently(state: SyncState, rows: readonly RowKey[]): SyncState {
  const targets = redactionTargets(state, rows);
  if (targets.length === 0) return state;
  const b = new StateBuilder(state);
  for (const row of targets) redactRow(b, row);
  return b.build();
}

/** [Empty Recently deleted]: deletePermanently for every row whose provisional `_life` is dead. */
export function emptyRecentlyDeleted(state: SyncState): SyncState {
  const dead: RowKey[] = [];
  for (const row of state.rows.values()) {
    if (isContentTbl(row.key.tbl) && deadSibling(row) !== null) dead.push(row.key);
  }
  return deletePermanently(state, dead);
}

/** "Some fields of this item were permanently deleted": a live row with a redacted-only register. */
export function hasRedactedFields(state: SyncState, row: RowKey): boolean {
  const r = state.rows.get(rowKeyStr(row));
  if (!r || !isContentTbl(r.key.tbl) || !isLive(r)) return false;
  for (const [name, reg] of r.regs) {
    if (name !== LIFE_REG && reg.sibs.length > 0 && reg.sibs.every(isRedacted)) return true;
  }
  return false;
}

// ---------- Helpers ----------

/** The provisional `_life` sibling when it is dead, else null. */
function deadSibling(row: RowState): Sibling | null {
  const reg = row.regs.get(LIFE_REG);
  if (!reg) return null;
  const p = provisional(LIFE_REG, reg.sibs);
  return p !== null && p.value === LIFE_DEAD ? p : null;
}

function isLive(row: RowState): boolean {
  const reg = row.regs.get(LIFE_REG);
  return !reg || provisional(LIFE_REG, reg.sibs)?.value === LIFE_LIVE;
}

/** Provisional text of a register; null when implicit with a null default, redacted-only or empty. */
function textValue(row: RowState, def: RegisterDef): string | null {
  const reg = row.regs.get(def.reg);
  const p = reg ? provisional(def.reg, reg.sibs) : null;
  const text = asText(p ? p.value : reg ? null : def.defaultValue);
  return text !== null && text.length > 0 ? text : null;
}

function newestFirst(a: DeletedItem, b: DeletedItem): number {
  return compareNum(b.diedMs, a.diedMs) || compareNum(a.row.tbl, b.row.tbl) || compareStr(a.row.rowId, b.row.rowId);
}

function redactionTargets(state: SyncState, rows: readonly RowKey[]): RowState[] {
  const targets = new Map<string, RowState>();
  const entries = new Set<string>();
  for (const key of rows) {
    const row = state.rows.get(rowKeyStr(key));
    if (!row || !isContentTbl(row.key.tbl) || deadSibling(row) === null) continue;
    targets.set(rowKeyStr(row.key), row);
    if (row.key.tbl === TBL.entries) entries.add(row.key.rowId);
  }
  if (entries.size === 0) return [...targets.values()];
  for (const row of state.rows.values()) {
    if (row.key.tbl === TBL.history && historyNamesAny(row, entries)) targets.set(rowKeyStr(row.key), row);
  }
  return [...targets.values()];
}

function historyNamesAny(row: RowState, entries: ReadonlySet<string>): boolean {
  const reg = row.regs.get(HISTORY_ENTRY_REG);
  if (!reg) return false;
  return reg.sibs.some((s) => {
    const id = asText(s.value);
    return id !== null && entries.has(id);
  });
}

function redactRow(b: StateBuilder, row: RowState): void {
  for (const [name, reg] of row.regs) {
    if (name === LIFE_REG) continue;
    const sibs = redactSiblings(reg.sibs);
    if (sibs !== reg.sibs || reg.mat !== undefined) b.setRegister({ key: reg.key, sibs, pmem: reg.pmem });
  }
  const grave = redactedGrave(row);
  if (grave !== row.grave) b.setGrave(row.key, grave);
}

function redactSiblings(sibs: readonly Sibling[]): readonly Sibling[] {
  let changed = false;
  const out = sibs.map((s) => {
    const r = redactSibling(s);
    if (r !== s) changed = true;
    return r;
  });
  return changed ? out : sibs;
}

function redactSibling(s: Sibling): Sibling {
  const done = s.value === null && s.vhash === ZERO_VHASH && isRedacted(s) && s.prevVhash === null;
  if (done) return s;
  return { ...s, value: null, vhash: ZERO_VHASH, flags: s.flags | SIB_REDACTED, prevVhash: null };
}

/** Dead rows get a redacted grave (created from the provisional dead sibling if missing). */
function redactedGrave(row: RowState): Grave | null {
  const dead = deadSibling(row);
  if (dead === null) return row.grave;
  if (row.grave !== null) return row.grave.redacted ? row.grave : { ...row.grave, redacted: true };
  return { diedMs: dead.ms, diedC: dead.c, diedDev: dead.dev, redacted: true };
}
