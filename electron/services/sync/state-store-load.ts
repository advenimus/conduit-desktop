/**
 * loadFile (spec 3.3, 3.4): reads a synced vault into a SyncState with a handful of full-table
 * SELECTs and Map joins. Heads come from sync_reg, other siblings from sync_sibling; a
 * sync_sibling row with the head's identity is a carrier of the head's value. Otherwise the
 * head's value comes from its home: sync_grave.row_json, the content row, or vault_meta.
 * Import through state-store.ts.
 */

import { isContentTbl, readContentRow, readMetaRegisters, registerDef } from './catalog.js';
import { vhashOfValue } from './hashing.js';
import { hasSyncTables, readSyncFormat, SYNC_STATE_KEYS } from './schema.js';
import { compareIdentity, isRedacted, isValueUnknown, withValueUnknown } from './sibling.js';
import {
  HASH16_BYTES,
  PREV_BYTES,
  blobToHex,
  cellToValue,
  corrupt,
  decodePmem,
  hexCell,
  num,
  pidFromHexCell,
  sameIdentity,
  str,
} from './state-store-codec.js';
import { loadContent } from './state-store-content.js';
import { rowKeyStr, wrapKeyStr } from './state-view.js';
import { valueFromText, valuesFromText } from './value-codec.js';
import {
  SyncCoreError,
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type Dev,
  type DevRecord,
  type EpochRecord,
  type Grave,
  type Hlc,
  type LoadedFile,
  type MatOverride,
  type Pmem,
  type RegisterState,
  type RowCacheEntry,
  type RowKey,
  type RowState,
  type Sibling,
  type SyncState,
  type SyncValue,
  type Tbl,
  type WrapRecord,
} from './types.js';
import type Database from 'better-sqlite3';

const KNOWN_TBLS: ReadonlySet<number> = new Set(Object.values(TBL));
const NOT_MATERIALIZED: RowCacheEntry = Object.freeze({ materialized: false, rawHash: null });
const INT_TEXT = /^-?\d+$/;

interface RawReg {
  readonly head: Sibling;
  readonly pmem: Pmem | null;
  readonly mat: MatOverride | undefined;
  readonly others: Sibling[];
  carrier: { readonly value: SyncValue } | null;
}

interface RawRow {
  readonly key: RowKey;
  readonly regs: Map<string, RawReg>;
  grave: Grave | null;
  rowJson: string | null;
  cache: RowCacheEntry;
}

type RawCells = readonly unknown[];

function all(db: Database.Database, sql: string): RawCells[] {
  return db.prepare(sql).raw().all() as RawCells[];
}

// ---------- Small tables ----------

interface Header {
  readonly lineageId: string;
  readonly genesisId: string;
  readonly createdMs: number;
  readonly fileId: string | null;
}

function readHeader(db: Database.Database): Header {
  const kv = new Map(all(db, 'SELECT key, value FROM sync_state').map(([k, v]) => [k, v] as const));
  const need = (key: string): string => {
    const v = kv.get(key);
    if (typeof v !== 'string' || v.length === 0) throw corrupt(`sync_state.${key} is missing`);
    return v;
  };
  const createdText = need(SYNC_STATE_KEYS.createdMs);
  const createdMs = Number(createdText);
  if (!INT_TEXT.test(createdText) || !Number.isSafeInteger(createdMs)) throw corrupt('sync_state.created_ms is not an integer');
  const fileId = kv.get(SYNC_STATE_KEYS.fileId);
  return {
    lineageId: need(SYNC_STATE_KEYS.lineageId),
    genesisId: need(SYNC_STATE_KEYS.genesisId),
    createdMs,
    fileId: typeof fileId === 'string' ? fileId : null,
  };
}

function readVv(db: Database.Database): Map<Dev, Hlc> {
  return new Map(all(db, 'SELECT dev, hlc_ms, hlc_c FROM sync_vv').map(([d, ms, c]) => [num(d, 'vv dev'), { ms: num(ms, 'vv ms'), c: num(c, 'vv c') }]));
}

function readDevs(db: Database.Database): Map<Dev, DevRecord> {
  const out = new Map<Dev, DevRecord>();
  for (const [d, uuid, started] of all(db, 'SELECT dev, device_uuid, started_ms FROM sync_dev')) {
    const dev = num(d, 'dev');
    out.set(dev, { dev, deviceUuid: str(uuid, 'device_uuid'), startedMs: num(started, 'started_ms') });
  }
  return out;
}

const optText = (v: unknown, what: string): string | null => (v === null ? null : str(v, what));

function readEpochs(db: Database.Database): Map<string, EpochRecord> {
  const out = new Map<string, EpochRecord>();
  const rows = all(db, 'SELECT epoch_id, parent_epoch, salt, verification, created_ms FROM sync_key_epoch');
  for (const [id, parent, salt, verification, created] of rows) {
    const epochId = str(id, 'epoch_id');
    out.set(epochId, {
      epochId,
      parent: optText(parent, 'parent_epoch'),
      salt: optText(salt, 'salt'),
      verification: optText(verification, 'verification'),
      createdMs: num(created, 'epoch created_ms'),
    });
  }
  return out;
}

function readWraps(db: Database.Database): Map<string, WrapRecord> {
  const out = new Map<string, WrapRecord>();
  for (const [e, t, w] of all(db, 'SELECT epoch_id, target_epoch, wrap FROM sync_key_wrap')) {
    const rec: WrapRecord = { epochId: str(e, 'wrap epoch_id'), targetEpoch: str(t, 'target_epoch'), wrap: blobToHex(w, null, 'wrap') };
    out.set(wrapKeyStr(rec), rec);
  }
  return out;
}

// ---------- Rows and registers ----------

function readRowKeys(db: Database.Database): Map<number, RawRow> {
  const out = new Map<number, RawRow>();
  for (const [rid, t, id] of all(db, 'SELECT rid, tbl, row_id FROM sync_rowkey')) {
    const tbl = num(t, 'tbl');
    if (!KNOWN_TBLS.has(tbl)) throw corrupt(`unknown tbl ${tbl}`);
    const key: RowKey = { tbl: tbl as Tbl, rowId: str(id, 'row_id') };
    out.set(num(rid, 'rid'), { key, regs: new Map(), grave: null, rowJson: null, cache: NOT_MATERIALIZED });
  }
  return out;
}

function rowOfRid(rows: ReadonlyMap<number, RawRow>, rid: unknown, table: string): RawRow {
  const row = rows.get(num(rid, 'rid'));
  if (!row) throw corrupt(`${table} row for unknown rid ${String(rid)}`);
  return row;
}

function readGraves(db: Database.Database, rows: ReadonlyMap<number, RawRow>): void {
  const sql = 'SELECT rid, row_json, died_ms, died_c, died_dev, redacted FROM sync_grave';
  for (const [rid, json, ms, c, dev, redacted] of all(db, sql)) {
    const row = rowOfRid(rows, rid, 'sync_grave');
    row.grave = { diedMs: num(ms, 'died_ms'), diedC: num(c, 'died_c'), diedDev: num(dev, 'died_dev'), redacted: num(redacted, 'redacted') !== 0 };
    row.rowJson = optText(json, 'row_json');
  }
}

function readCache(db: Database.Database, rows: ReadonlyMap<number, RawRow>): void {
  for (const [rid, materialized, hash] of all(db, 'SELECT rid, materialized, raw_hash FROM sync_row')) {
    const row = rows.get(num(rid, 'rid'));
    if (!row) continue;
    row.cache = {
      materialized: num(materialized, 'materialized') !== 0,
      rawHash: hash === null ? null : blobToHex(hash, HASH16_BYTES, 'raw_hash'),
    };
  }
}

function readRegisters(db: Database.Database, rows: ReadonlyMap<number, RawRow>): void {
  const sql =
    'SELECT rid, reg, dev, hlc_ms, hlc_c, lower(hex(pid)), lt, lower(hex(vhash)), lower(hex(prev_vhash)), ' +
    'flags, pmem_ms, pmem_ids, mat FROM sync_reg';
  for (const [rid, reg, d, ms, c, pid, lt, vhash, prev, flags, pmemMs, pmemIds, mat] of all(db, sql)) {
    const row = rowOfRid(rows, rid, 'sync_reg');
    const dev = num(d, 'dev');
    const head: Sibling = {
      dev,
      ms: num(ms, 'hlc_ms'),
      c: num(c, 'hlc_c'),
      pid: pidFromHexCell(dev, pid),
      lt: num(lt, 'lt'),
      vhash: hexCell(vhash, HASH16_BYTES, 'vhash'),
      flags: num(flags, 'flags'),
      value: null,
      prevVhash: prev === '' ? null : hexCell(prev, PREV_BYTES, 'prev_vhash'),
    };
    const matOverride = mat === null ? undefined : { value: parseMat(mat) };
    row.regs.set(str(reg, 'reg'), { head, pmem: decodePmem(pmemMs, pmemIds, head), mat: matOverride, others: [], carrier: null });
  }
}

function parseMat(text: unknown): SyncValue {
  try {
    return valueFromText(str(text, 'mat'));
  } catch (err) {
    if (err instanceof SyncCoreError) throw err;
    throw corrupt('mat is not an encoded value');
  }
}

function readSiblings(db: Database.Database, rows: ReadonlyMap<number, RawRow>): void {
  const sql =
    'SELECT rid, reg, dev, hlc_ms, hlc_c, lower(hex(pid)), lt, lower(hex(vhash)), flags, value FROM sync_sibling';
  for (const [rid, reg, d, ms, c, pid, lt, vhash, flags, value] of all(db, sql)) {
    const raw = rowOfRid(rows, rid, 'sync_sibling').regs.get(str(reg, 'reg'));
    if (!raw) throw corrupt('sync_sibling row without a sync_reg row');
    const dev = num(d, 'dev');
    const sib: Sibling = {
      dev,
      ms: num(ms, 'hlc_ms'),
      c: num(c, 'hlc_c'),
      pid: pidFromHexCell(dev, pid),
      lt: num(lt, 'lt'),
      vhash: hexCell(vhash, HASH16_BYTES, 'vhash'),
      flags: num(flags, 'flags'),
      value: cellToValue(value),
      prevVhash: null,
    };
    if (sameIdentity(raw.head, sib.dev, sib.ms, sib.c, sib.pid)) raw.carrier = { value: sib.value };
    else raw.others.push(sib);
  }
}

// ---------- Head values ----------

/** Where the heads of one row keep their values when they have no carrier. */
interface RowHome {
  readonly grave: ReadonlyMap<string, SyncValue> | null;
  readonly content: ReadonlyMap<string, SyncValue> | null;
  /** Content columns that did not parse ('config', 'tags'): their family values are unreadable. */
  readonly malformed: ReadonlySet<string>;
  /** The content row vanished although sync_row expects it (a legacy delete). */
  readonly vanished: boolean;
}

const NO_MALFORMED: ReadonlySet<string> = new Set();

/** A head whose value the home cannot supply (a malformed family column). */
const VALUE_UNKNOWN = Symbol('value-unknown');
type HomeValue = SyncValue | typeof VALUE_UNKNOWN;

function parseRowJson(text: string): Map<string, SyncValue> {
  try {
    return valuesFromText(text);
  } catch {
    throw corrupt('sync_grave.row_json is not an encoded row');
  }
}

function contentRowOf(content: ContentSnapshot, tbl: ContentTbl, rowId: string): ContentRow | undefined {
  if (tbl === TBL.entries) return content.entries.get(rowId);
  if (tbl === TBL.folders) return content.folders.get(rowId);
  return content.history.get(rowId);
}

function homeOf(row: RawRow, content: ContentSnapshot): RowHome {
  const none = { grave: null, content: null, malformed: NO_MALFORMED, vanished: false };
  if (row.rowJson !== null) return { ...none, grave: parseRowJson(row.rowJson) };
  const { tbl, rowId } = row.key;
  if (tbl === TBL.meta) return { ...none, content: readMetaRegisters(content.meta) };
  if (!isContentTbl(tbl)) return none;
  const found = contentRowOf(content, tbl, rowId);
  if (!found) return { ...none, vanished: row.cache.materialized };
  const read = readContentRow(tbl, found);
  return { ...none, content: read.values, malformed: read.malformed.length > 0 ? new Set(read.malformed) : NO_MALFORMED };
}

/**
 * A family register missing from its content row is absent (null), unless its column did not
 * parse: then the value is unknown here, and a head that is not an explicit absence says so,
 * so a malformed column never reads as "every key removed" (4.5 one identity, one value).
 */
function familyHomeValue(row: RawRow, reg: string, raw: RawReg, home: RowHome): HomeValue {
  const key = { ...row.key, reg };
  const def = registerDef(key);
  if (!def?.family) throw corrupt(`no content value for ${row.key.tbl}/${reg}`);
  const unreadable = def.columns.some((c) => home.malformed.has(c));
  return unreadable && raw.head.vhash !== vhashOfValue(key, null) ? VALUE_UNKNOWN : null;
}

function homeValue(row: RawRow, reg: string, raw: RawReg, home: RowHome): HomeValue {
  if (home.grave !== null) {
    if (!home.grave.has(reg)) throw corrupt(`row_json lacks ${reg}`);
    return home.grave.get(reg) as SyncValue;
  }
  if (isRedacted(raw.head) || isValueUnknown(raw.head)) return null;
  if (home.content !== null) {
    if (home.content.has(reg)) return home.content.get(reg) as SyncValue;
    return familyHomeValue(row, reg, raw, home);
  }
  // Unknown until capture: the legacy delete makes capture replace or recover these heads.
  if (home.vanished) return null;
  throw corrupt(`no stored value for ${row.key.tbl}/${reg}`);
}

function finishRow(row: RawRow, content: ContentSnapshot): RowState {
  let home: RowHome | null = null;
  const regs = new Map<string, RegisterState>();
  for (const [reg, raw] of row.regs) {
    let value: HomeValue;
    if (raw.carrier !== null) value = raw.carrier.value;
    else {
      home ??= homeOf(row, content);
      value = homeValue(row, reg, raw, home);
    }
    const head: Sibling = headWith(raw.head, value);
    const sibs = raw.others.length === 0 ? [head] : [head, ...raw.others].sort(compareIdentity);
    const state: RegisterState = { key: { tbl: row.key.tbl, rowId: row.key.rowId, reg }, sibs, pmem: raw.pmem };
    regs.set(reg, raw.mat === undefined ? state : { ...state, mat: raw.mat });
  }
  return { key: row.key, regs, grave: row.grave };
}

function headWith(head: Sibling, value: HomeValue): Sibling {
  if (value === VALUE_UNKNOWN || isValueUnknown(head)) return withValueUnknown(head);
  return { ...head, value };
}

// ---------- Entry point ----------

function readAll(db: Database.Database): LoadedFile {
  const content = loadContent(db);
  const header = readHeader(db);
  const raw = readRowKeys(db);
  readGraves(db, raw);
  readCache(db, raw);
  readRegisters(db, raw);
  readSiblings(db, raw);
  const rows = new Map<string, RowState>();
  const cache = new Map<string, RowCacheEntry>();
  for (const row of raw.values()) {
    const k = rowKeyStr(row.key);
    rows.set(k, finishRow(row, content));
    if (isContentTbl(row.key.tbl)) cache.set(k, row.cache);
  }
  const state: SyncState = {
    lineageId: header.lineageId,
    genesisId: header.genesisId,
    createdMs: header.createdMs,
    vv: readVv(db),
    devs: readDevs(db),
    rows,
    epochs: readEpochs(db),
    wraps: readWraps(db),
  };
  return { state, content, cache, fileId: header.fileId, syncFormat: readSyncFormat(db) };
}

/** Loads everything from one read snapshot. Head values may be stale until capture runs. */
export function loadFile(db: Database.Database): LoadedFile {
  if (!hasSyncTables(db)) throw new SyncCoreError('UNSUPPORTED_FORMAT', 'state-store: file has no sync tables');
  return db.transaction(readAll)(db);
}
