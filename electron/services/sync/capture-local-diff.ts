/**
 * The capture row pass (spec 4.2 steps 1-3): finds inserted, resurrected, edited and deleted
 * rows and the registers whose content differs from what the state expects. Pure: no writes;
 * capture-local and capture-legacy attribute the result.
 */

import {
  CONTENT_TBLS,
  LIFE_DEAD,
  LIFE_LIVE,
  LIFE_REG,
  META_ROW_ID,
  isContentTbl,
  readContentRow,
  readMetaRegisters,
  regKey,
  registerDef,
  rowKey,
  type RowRead,
} from './catalog.js';
import { rawHash, vhashOfValue } from './hashing.js';
import { isDefaultRaw, matchesExpected, observe, type Observation, type SecretKeys } from './capture-local-observe.js';
import { isRedacted } from './sibling.js';
import { StateBuilder, parseRowKeyStr, provisional, rowKeyStr } from './state-view.js';
import {
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type RegKey,
  type RegisterDef,
  type RowCache,
  type RowKey,
  type RowState,
  type Sibling,
  type SyncState,
  type SyncValue,
} from './types.js';

export type RowDiffKind = 'insert' | 'resurrect' | 'edit' | 'delete';

export interface RegChange {
  readonly key: RegKey;
  readonly def: RegisterDef;
  readonly obs: Observation;
}

export interface RowDiff {
  readonly row: RowKey;
  readonly kind: RowDiffKind;
  /** The content row for inserts, resurrections and edits; null for vault_meta. */
  readonly content: ContentRow | null;
  /** Changed registers other than `_life` (inserts and resurrections also change `_life`). */
  readonly changes: readonly RegChange[];
}

export interface Diffs {
  /**
   * The input state, with the `_life` head values of vanished rows restored from their vhash
   * (the loader cannot read them from a content row that is gone); the capture builds on it.
   */
  readonly base: SyncState;
  /** Inserts, resurrections and edits, including the vault_meta row. */
  readonly rows: readonly RowDiff[];
  /** Materialized live content rows that vanished from content. */
  readonly deletes: readonly RowKey[];
  /** Changed rows the legacy filter told capture to ignore. */
  readonly skipped: readonly RowKey[];
  /**
   * Rows with a config or tags column that did not parse. Their family registers were not
   * compared, and their family head values are unknown (state-store-load); legacy capture
   * recovers them.
   */
  readonly malformed: readonly RowKey[];
  /**
   * Unchanged secrets whose stored ciphertext opened only with a non-target key (4.8 stale
   * key): the head value loaded from that content must be re-encrypted under the target key.
   */
  readonly reseals: readonly RegChange[];
}

export interface DiffInput {
  readonly state: SyncState;
  readonly content: ContentSnapshot;
  readonly cache: RowCache;
}

export interface DiffOptions {
  readonly keys: SecretKeys;
  readonly skipRow?: (row: RowKey, content: ContentRow) => boolean;
}

const NO_MALFORMED: ReadonlySet<string> = new Set();

/** Side outputs of one row pass, filled while rows are compared. */
interface PassOut {
  readonly rows: RowDiff[];
  readonly skipped: RowKey[];
  readonly malformed: RowKey[];
  readonly reseals: RegChange[];
}

function newPassOut(): PassOut {
  return { rows: [], skipped: [], malformed: [], reseals: [] };
}

export function contentRows(content: ContentSnapshot, tbl: ContentTbl): ReadonlyMap<string, ContentRow> {
  if (tbl === TBL.entries) return content.entries;
  if (tbl === TBL.folders) return content.folders;
  return content.history;
}

function isLive(rs: RowState): boolean {
  const life = rs.regs.get(LIFE_REG);
  return !life || provisional(LIFE_REG, life.sibs)?.value === LIFE_LIVE;
}

/** Full pass: every content row, every materialized row (deletes) and vault_meta. */
export function diffFull(input: DiffInput, opts: DiffOptions): Diffs {
  const out = newPassOut();
  for (const tbl of CONTENT_TBLS) {
    for (const row of contentRows(input.content, tbl).values()) {
      collect(diffContentRow(input, tbl, row, opts, out), out);
    }
  }
  const meta = diffMeta(input.state, input.content.meta, opts.keys);
  if (meta) out.rows.push(meta);
  return withDeletes(input.state, out, fullVanished(input));
}

/** Per-operation pass over the listed rows only (their deletes included). */
export function diffRows(input: DiffInput, list: readonly RowKey[], opts: DiffOptions): Diffs {
  const out = newPassOut();
  const vanished: RowKey[] = [];
  const seen = new Set<string>();
  for (const rk of list) {
    const ks = rowKeyStr(rk);
    if (seen.has(ks)) continue;
    seen.add(ks);
    if (rk.tbl === TBL.meta) {
      const meta = diffMeta(input.state, input.content.meta, opts.keys);
      if (meta) out.rows.push(meta);
      continue;
    }
    if (!isContentTbl(rk.tbl)) continue;
    const row = contentRows(input.content, rk.tbl).get(rk.rowId);
    if (row) collect(diffContentRow(input, rk.tbl, row, opts, out), out);
    else if (input.cache.get(ks)?.materialized === true) vanished.push(rowKey(rk.tbl, rk.rowId));
  }
  return withDeletes(input.state, out, vanished);
}

type ContentDiff = RowDiff | { readonly skipped: RowKey } | null;

function collect(d: ContentDiff, out: PassOut): void {
  if (d === null) return;
  if ('skipped' in d) out.skipped.push(d.skipped);
  else out.rows.push(d);
}

/** Materialized content rows that are missing from content. */
function fullVanished(input: DiffInput): RowKey[] {
  const out: RowKey[] = [];
  for (const [ks, entry] of input.cache) {
    if (!entry.materialized) continue;
    const rk = parseRowKeyStr(ks);
    if (isContentTbl(rk.tbl) && !contentRows(input.content, rk.tbl).has(rk.rowId)) out.push(rk);
  }
  return out;
}

/** A vanished row is a delete when its (restored) provisional `_life` is live. */
function withDeletes(state: SyncState, out: PassOut, vanished: readonly RowKey[]): Diffs {
  const base = restoreVanishedLife(state, vanished);
  const deletes = vanished.filter((rk) => {
    const rs = base.rows.get(rowKeyStr(rk));
    return rs !== undefined && isLive(rs);
  });
  return { base, rows: out.rows, deletes, skipped: out.skipped, malformed: out.malformed, reseals: out.reseals };
}

function lifeByHash(key: RegKey, s: Sibling): SyncValue {
  if (s.value === LIFE_LIVE || s.value === LIFE_DEAD || isRedacted(s)) return s.value;
  if (s.vhash === vhashOfValue(key, LIFE_LIVE)) return LIFE_LIVE;
  return s.vhash === vhashOfValue(key, LIFE_DEAD) ? LIFE_DEAD : s.value;
}

/** `_life` has two values, so a head value lost with its content row is recovered from its vhash. */
function restoreVanishedLife(state: SyncState, vanished: readonly RowKey[]): SyncState {
  let b: StateBuilder | null = null;
  for (const rk of vanished) {
    const key = regKey(rk.tbl, rk.rowId, LIFE_REG);
    const reg = state.rows.get(rowKeyStr(rk))?.regs.get(LIFE_REG);
    if (!reg) continue;
    const sibs = reg.sibs.map((s) => {
      const value = lifeByHash(key, s);
      return value === s.value ? s : { ...s, value };
    });
    if (sibs.every((s, i) => s === reg.sibs[i])) continue;
    b ??= new StateBuilder(state);
    b.setRegister({ ...reg, sibs });
  }
  return b === null ? state : b.build();
}

function diffContentRow(input: DiffInput, tbl: ContentTbl, row: ContentRow, opts: DiffOptions, out: PassOut): ContentDiff {
  const rk = rowKey(tbl, row.id);
  const ks = rowKeyStr(rk);
  const cached = input.cache.get(ks);
  if (cached?.materialized && cached.rawHash !== null && cached.rawHash === rawHash(tbl, row)) return null;
  if (opts.skipRow?.(rk, row)) return { skipped: rk };
  const read = readContentRow(tbl, row);
  const rs = input.state.rows.get(ks);
  if (!rs) return { row: rk, kind: 'insert', content: row, changes: insertChanges(rk, read, opts.keys) };
  if (read.malformed.length > 0) out.malformed.push(rk);
  const changes = compareRegisters(rs, rk, read, opts.keys, out.reseals);
  const kind: RowDiffKind = cached?.materialized !== true || !isLive(rs) ? 'resurrect' : 'edit';
  if (kind === 'edit' && changes.length === 0) return null;
  return { row: rk, kind, content: row, changes };
}

function insertChanges(rk: RowKey, read: RowRead, keys: SecretKeys): RegChange[] {
  const out: RegChange[] = [];
  for (const [reg, v] of read.values) {
    if (reg === LIFE_REG) continue;
    const change = newRegister(regKey(rk.tbl, rk.rowId, reg), v, keys);
    if (change) out.push(change);
  }
  return out;
}

function newRegister(key: RegKey, value: SyncValue, keys: SecretKeys): RegChange | null {
  const def = registerDef(key);
  if (!def || isDefaultRaw(def, value)) return null;
  return { key, def, obs: observe(key, def, value, keys) };
}

function isMalformedFamily(def: RegisterDef, malformed: ReadonlySet<string>): boolean {
  return def.family !== null && def.columns.some((c) => malformed.has(c));
}

interface CompareEnv {
  readonly keys: SecretKeys;
  readonly malformed: ReadonlySet<string>;
  readonly reseals: RegChange[];
}

function compareOne(rs: RowState, key: RegKey, value: SyncValue, env: CompareEnv): RegChange | null {
  const def = registerDef(key);
  if (!def || isMalformedFamily(def, env.malformed)) return null;
  const reg = rs.regs.get(key.reg);
  if (!reg && isDefaultRaw(def, value)) return null;
  const obs = observe(key, def, value, env.keys);
  if (!matchesExpected(key, def, reg, obs, env.keys)) return { key, def, obs };
  if (obs.reseal !== null) env.reseals.push({ key, def, obs });
  return null;
}

/**
 * Registers present in the row plus explicit `config.*`/`tag:*` registers the row no longer
 * has (absent = null). Families whose column did not parse are skipped: a malformed column
 * must not read as "every key removed".
 */
function compareRegisters(rs: RowState, rk: RowKey, read: RowRead, keys: SecretKeys, reseals: RegChange[]): RegChange[] {
  const out: RegChange[] = [];
  const env: CompareEnv = { keys, malformed: read.malformed.length > 0 ? new Set(read.malformed) : NO_MALFORMED, reseals };
  for (const [reg, v] of read.values) {
    if (reg === LIFE_REG) continue;
    const change = compareOne(rs, regKey(rk.tbl, rk.rowId, reg), v, env);
    if (change) out.push(change);
  }
  for (const [reg, state] of rs.regs) {
    if (reg === LIFE_REG || read.values.has(reg)) continue;
    const def = registerDef(state.key);
    if (!def || def.family === null) continue;
    const change = compareOne(rs, state.key, null, env);
    if (change) out.push(change);
  }
  return out;
}

/** vault_meta registers (vault_id, cloud_sync_enabled): rowless, never `_life`. */
export function diffMeta(state: SyncState, meta: ReadonlyMap<string, string>, keys: SecretKeys): RowDiff | null {
  const rk = rowKey(TBL.meta, META_ROW_ID);
  const rs = state.rows.get(rowKeyStr(rk));
  const changes: RegChange[] = [];
  const env: CompareEnv = { keys, malformed: NO_MALFORMED, reseals: [] };
  for (const [reg, v] of readMetaRegisters(meta)) {
    const key = regKey(TBL.meta, META_ROW_ID, reg);
    const change = rs ? compareOne(rs, key, v, env) : newRegister(key, v, keys);
    if (change) changes.push(change);
  }
  return changes.length > 0 ? { row: rk, kind: 'edit', content: null, changes } : null;
}
