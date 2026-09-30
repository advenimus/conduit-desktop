/**
 * Register-level helpers for materialization (spec 4.6 steps 2 and 6): the materialized value
 * of every register of a row, canonical comparison of register values and content rows,
 * `mat` overrides and updated_at derivation. Part of materialize.ts; import through it.
 */

import { canonEqual, formatIsoMs } from './canonical.js';
import {
  CONTENT_COLUMNS,
  fixedRegisters,
  normalizeValue,
  registerDef,
  type RowRead,
} from './catalog.js';
import { isPseudo, valuesIdentical } from './sibling.js';
import { headOf, provisional } from './state-view.js';
import type {
  ContentRow,
  ContentTbl,
  RegisterDef,
  RegisterState,
  RowState,
  SqlValue,
  SyncValue,
} from './types.js';

const UPDATED_AT_COLUMN = 'updated_at';

/** Provisional value, or the catalog default when implicit or when no sibling is eligible. */
export function registerValue(def: RegisterDef, reg: RegisterState | undefined): SyncValue {
  if (!reg) return def.defaultValue;
  const p = provisional(reg.key.reg, reg.sibs);
  return p === null ? def.defaultValue : p.value;
}

/**
 * Every fixed register (provisional or default) plus every dynamic register whose value is
 * present. Registers outside the catalog are ignored (they never materialize).
 */
export function rowValues(tbl: ContentTbl, row: RowState): Map<string, SyncValue> {
  const values = new Map<string, SyncValue>();
  for (const def of fixedRegisters(tbl)) values.set(def.reg, registerValue(def, row.regs.get(def.reg)));
  for (const [name, reg] of row.regs) {
    if (values.has(name)) continue;
    const def = registerDef(reg.key);
    if (!def || def.family === null) continue;
    const v = registerValue(def, reg);
    if (v !== null) values.set(name, v);
  }
  return values;
}

/**
 * NOT NULL columns take the catalog fallback. An empty required text with a non-empty fallback
 * also falls back: entries.entry_type has a CHECK constraint that rejects ''.
 */
export function applyRequiredFallbacks(tbl: ContentTbl, values: Map<string, SyncValue>): void {
  for (const def of fixedRegisters(tbl)) {
    if (def.notNullFallback === null) continue;
    const v = values.get(def.reg) ?? null;
    const emptyRequired = def.kind === 'reqtext' && v === '' && def.notNullFallback !== '';
    if (v === null || emptyRequired) values.set(def.reg, def.notNullFallback);
  }
}

/** Canonical equality (3.6). Secrets compare their stored bytes: materialize holds no keys. */
export function valueEq(def: RegisterDef, a: SyncValue, b: SyncValue): boolean {
  const na = normalizeValue(def, a);
  const nb = normalizeValue(def, b);
  if (valuesIdentical(na, nb)) return true;
  if (def.secret) return false;
  return (def.kind === 'time' || def.kind === 'json') && canonEqual(def, a, b);
}

/** Register-level equality of two reads of one table's rows, over the union of their registers. */
export function readsEqual(tbl: ContentTbl, a: RowRead, b: RowRead): boolean {
  if (a.malformed.length > 0 || b.malformed.length > 0) return false;
  for (const [name, va] of a.values) {
    if (!regEq(tbl, name, va, b.values.get(name) ?? null)) return false;
  }
  for (const [name, vb] of b.values) {
    if (!a.values.has(name) && !regEq(tbl, name, null, vb)) return false;
  }
  return true;
}

function regEq(tbl: ContentTbl, name: string, va: SyncValue, vb: SyncValue): boolean {
  const def = registerDef({ tbl, rowId: '', reg: name });
  return def ? valueEq(def, va, vb) : valuesIdentical(va, vb);
}

function cellEq(a: SqlValue, b: SqlValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && Buffer.compare(a, b) === 0;
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const ba = asBigInt(a);
    return ba !== null && ba === asBigInt(b);
  }
  return a === b;
}

function asBigInt(v: SqlValue): bigint | null {
  if (typeof v === 'bigint') return v;
  return typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;
}

/** Byte-level equality of every column except updated_at (the cheap path of the content diff). */
export function columnsIdentical(tbl: ContentTbl, a: ContentRow, b: ContentRow): boolean {
  const ra = a as unknown as Record<string, SqlValue>;
  const rb = b as unknown as Record<string, SqlValue>;
  for (const col of CONTENT_COLUMNS[tbl]) {
    if (col !== UPDATED_AT_COLUMN && !cellEq(ra[col] ?? null, rb[col] ?? null)) return false;
  }
  return true;
}

/**
 * The `mat` a register needs: the value capture will read back from the content when it is
 * not canonically equal to the head's logical value, else undefined.
 */
export function matFor(reg: RegisterState, readBack: SyncValue): SyncValue | undefined {
  const def = registerDef(reg.key);
  const head = headOf(reg.key.reg, reg.sibs);
  if (!def || head === null) return undefined;
  return valueEq(def, head.value, readBack) ? undefined : readBack;
}

/** The same register object when its mat already matches; otherwise a copy with the new mat. */
export function withMat(reg: RegisterState, mat: SyncValue | undefined): RegisterState {
  if (mat === undefined) {
    if (reg.mat === undefined) return reg;
    return { key: reg.key, sibs: reg.sibs, pmem: reg.pmem };
  }
  if (reg.mat !== undefined && valuesIdentical(reg.mat.value, mat)) return reg;
  return { key: reg.key, sibs: reg.sibs, pmem: reg.pmem, mat: { value: mat } };
}

/** Largest provisional app-dot ms or pseudo lt over the row's explicit registers (0 if none). */
export function latestRowTimeMs(row: RowState | undefined): number {
  let latest = 0;
  if (!row) return latest;
  for (const [name, reg] of row.regs) {
    const p = provisional(name, reg.sibs);
    if (p === null) continue;
    const t = isPseudo(p) ? p.lt : p.ms;
    if (t > latest) latest = t;
  }
  return latest;
}

export function updatedAtFor(row: RowState | undefined, storedText: string | null, fallback: string): string {
  const latest = latestRowTimeMs(row);
  if (latest > 0) return formatIsoMs(latest);
  return storedText !== null && storedText.length > 0 ? storedText : fallback;
}
