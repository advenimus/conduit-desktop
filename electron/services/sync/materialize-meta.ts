/**
 * vault_meta part of materialization (spec 4.6 step 6): the synced registers vault_id and
 * cloud_sync_enabled, their `mat` overrides, and salt, verification and key_source of the
 * current key epoch. schema_version, sync_format and team_vault_id are never touched.
 * Part of materialize.ts.
 */

import { KEY_SOURCE_PASSWORD, META_ROW_ID, asText, fixedRegisters } from './catalog.js';
import { matFor, registerValue, valueEq, withMat } from './materialize-values.js';
import { rowKeyStr, type StateBuilder } from './state-view.js';
import { TBL, type ContentSnapshot, type EpochRecord, type RowState, type SyncState, type SyncValue } from './types.js';

const SALT_KEY = 'salt';
const VERIFICATION_KEY = 'verification';
const KEY_SOURCE_KEY = 'key_source';

/** vault_meta writes (null deletes a key), only where the stored value differs. */
export function planMeta(
  state: SyncState,
  current: ContentSnapshot,
  builder: StateBuilder,
  epoch: EpochRecord | null,
): Map<string, string | null> {
  const plan = new Map<string, string | null>();
  const row = state.rows.get(rowKeyStr({ tbl: TBL.meta, rowId: META_ROW_ID }));
  if (row) planMetaRegisters(row, current.meta, builder, plan);
  if (epoch) {
    setIfDifferent(current.meta, plan, SALT_KEY, epoch.salt);
    setIfDifferent(current.meta, plan, VERIFICATION_KEY, epoch.verification);
    setIfDifferent(current.meta, plan, KEY_SOURCE_KEY, KEY_SOURCE_PASSWORD);
  }
  return plan;
}

function planMetaRegisters(
  row: RowState,
  meta: ReadonlyMap<string, string>,
  builder: StateBuilder,
  plan: Map<string, string | null>,
): void {
  const fixed = new Set<string>();
  for (const def of fixedRegisters(TBL.meta)) {
    fixed.add(def.reg);
    const reg = row.regs.get(def.reg);
    const value = registerValue(def, reg);
    const stored = meta.get(def.reg) ?? null;
    let final: SyncValue = stored;
    if (!valueEq(def, value, stored)) {
      final = metaText(value);
      plan.set(def.reg, final);
    }
    if (!reg) continue;
    const next = withMat(reg, matFor(reg, final));
    if (next !== reg) builder.setRegister(next);
  }
  for (const [name, reg] of row.regs) {
    if (!fixed.has(name) && reg.mat !== undefined) builder.setRegister(withMat(reg, undefined));
  }
}

/** vault_meta.value is NOT NULL text; an empty or null value deletes the key. */
function metaText(v: SyncValue): string | null {
  const text = asText(v);
  return text === null || text.length === 0 ? null : text;
}

/** Epoch values are only ever written, never deleted: a null here means "unknown", not "remove". */
function setIfDifferent(
  meta: ReadonlyMap<string, string>,
  plan: Map<string, string | null>,
  key: string,
  value: string | null,
): void {
  if (value !== null && meta.get(key) !== value) plan.set(key, value);
}
