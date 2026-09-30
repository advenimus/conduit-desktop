/**
 * saveState (spec 3.3, 4.6 steps 5-6): one IMMEDIATE transaction that applies the content
 * plan, then writes the sync tables. Explicit registers only (implicit ones have no row); the
 * head goes to sync_reg, every other sibling to sync_sibling. Each head's value lives in one
 * home: the content row (tbl 1-3 materialized, tbl 4 vault_meta), sync_grave.row_json (dead
 * rows with an unredacted grave), or a carrier row in sync_sibling (everything else, and every
 * register with `mat`). Redacted heads whose value is NULL need no home.
 * With a baseline only rows whose RowState object or cache entry changed are rewritten.
 * Import through state-store.ts.
 */

import { isContentTbl } from './catalog.js';
import { SYNC_STATE_KEYS } from './schema.js';
import { isRedacted } from './sibling.js';
import {
  HASH16_BYTES,
  bindValue,
  encodePmem,
  hexToBlob,
  invariant,
  pidToBlob,
  prevToBlob,
} from './state-store-codec.js';
import { applyWritePlan } from './state-store-content.js';
import { headOf, isImplicitEquivalent, rowKeyStr } from './state-view.js';
import { valueToText, valuesToText } from './value-codec.js';
import {
  PSEUDO_DEV,
  TBL,
  type LoadedFile,
  type RegisterState,
  type RowCacheEntry,
  type RowState,
  type Sibling,
  type SyncState,
  type SyncValue,
  type Tbl,
  type WritePlan,
  type RowCache,
} from './types.js';
import type Database from 'better-sqlite3';

export interface SaveInput {
  readonly state: SyncState;
  /** null when content does not change (pure sync-table save). */
  readonly plan: WritePlan | null;
  /** The sync_row contents after this save (MaterializeResult.cache). */
  readonly cache: RowCache;
  /**
   * What the file held before (the LoadedFile this state descends from). When given, only rows
   * whose RowState object or cache entry changed are rewritten; when null, every sync table is
   * rewritten from scratch.
   */
  readonly baseline: LoadedFile | null;
  /** Written to sync_state.file_id when given (publish path); null removes it. */
  readonly fileId?: string | null;
}

type Home = 'content' | 'grave' | 'none';

const EMPTY_PID = Buffer.alloc(0);
const ROW_TABLES = ['sync_reg', 'sync_sibling', 'sync_row', 'sync_grave'] as const;
// Every sync table but sync_state: file_id is per file and survives a full rewrite.
const REWRITTEN_TABLES = ['sync_vv', 'sync_dev', 'sync_key_epoch', 'sync_key_wrap', 'sync_rowkey', ...ROW_TABLES] as const;

// ---------- Statements ----------

interface Stmts {
  readonly insRowKey: Database.Statement;
  readonly insReg: Database.Statement;
  readonly insSib: Database.Statement;
  readonly insRow: Database.Statement;
  readonly insGrave: Database.Statement;
  readonly delRowKey: Database.Statement;
  readonly delRowData: readonly Database.Statement[];
}

function prepare(db: Database.Database): Stmts {
  return {
    insRowKey: db.prepare('INSERT INTO sync_rowkey (rid, tbl, row_id) VALUES (?, ?, ?)'),
    insReg: db.prepare(
      'INSERT INTO sync_reg (rid, reg, dev, hlc_ms, hlc_c, pid, lt, vhash, prev_vhash, flags, pmem_ms, pmem_ids, mat) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insSib: db.prepare(
      'INSERT INTO sync_sibling (rid, reg, dev, hlc_ms, hlc_c, pid, lt, vhash, flags, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insRow: db.prepare('INSERT INTO sync_row (rid, materialized, raw_hash) VALUES (?, ?, ?)'),
    insGrave: db.prepare(
      'INSERT INTO sync_grave (rid, row_json, died_ms, died_c, died_dev, redacted) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    delRowKey: db.prepare('DELETE FROM sync_rowkey WHERE rid = ?'),
    delRowData: ROW_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE rid = ?`)),
  };
}

// ---------- One row ----------

function homeOf(row: RowState, cache: RowCacheEntry | undefined): Home {
  const { tbl } = row.key;
  if (tbl === TBL.meta) return 'content';
  if (!isContentTbl(tbl)) return 'none';
  if (row.grave !== null && !row.grave.redacted) return 'grave';
  return cache?.materialized ? 'content' : 'none';
}

function needsCarrier(home: Home, reg: RegisterState, head: Sibling): boolean {
  if (isRedacted(head) && head.value === null) return false;
  if (home === 'grave') return false;
  return home === 'none' || reg.mat !== undefined;
}

function checkPid(s: Sibling): void {
  if (s.dev !== PSEUDO_DEV && s.pid !== '') throw invariant('app sibling with a pid');
}

function insertSibling(st: Stmts, rid: number, name: string, s: Sibling): void {
  checkPid(s);
  const vhash = hexToBlob(s.vhash, HASH16_BYTES, 'vhash');
  st.insSib.run(rid, name, s.dev, s.ms, s.c, pidToBlob(s) ?? EMPTY_PID, s.lt, vhash, s.flags, bindValue(s.value));
}

function writeRegister(st: Stmts, rid: number, name: string, reg: RegisterState, head: Sibling, carrier: boolean): void {
  checkPid(head);
  const pm = encodePmem(reg.pmem, head);
  const mat = reg.mat === undefined ? null : valueToText(reg.mat.value);
  const vhash = hexToBlob(head.vhash, HASH16_BYTES, 'vhash');
  const prev = prevToBlob(head.prevVhash);
  st.insReg.run(rid, name, head.dev, head.ms, head.c, pidToBlob(head), head.lt, vhash, prev, head.flags, pm.ms, pm.ids, mat);
  for (const s of reg.sibs) {
    if (s !== head || carrier) insertSibling(st, rid, name, s);
  }
}

function writeRow(st: Stmts, rid: number, row: RowState, cache: RowCacheEntry | undefined): void {
  const home = homeOf(row, cache);
  const graveValues = home === 'grave' ? new Map<string, SyncValue>() : null;
  for (const name of [...row.regs.keys()].sort()) {
    const reg = row.regs.get(name) as RegisterState;
    if (isImplicitEquivalent(reg)) continue;
    const head = headOf(name, reg.sibs);
    if (head === null) throw invariant(`explicit register ${row.key.tbl}/${name} has no siblings`);
    writeRegister(st, rid, name, reg, head, needsCarrier(home, reg, head));
    graveValues?.set(name, head.value);
  }
  const g = row.grave;
  if (g !== null) {
    const json = graveValues === null ? null : valuesToText(graveValues);
    st.insGrave.run(rid, json, g.diedMs, g.diedC, g.diedDev, g.redacted ? 1 : 0);
  }
  if (isContentTbl(row.key.tbl) && cache && (cache.materialized || cache.rawHash !== null)) {
    const hash = cache.rawHash === null ? null : hexToBlob(cache.rawHash, HASH16_BYTES, 'raw_hash');
    st.insRow.run(rid, cache.materialized ? 1 : 0, hash);
  }
}

function rewriteRow(st: Stmts, rid: number, row: RowState, cache: RowCacheEntry | undefined): void {
  for (const del of st.delRowData) del.run(rid);
  writeRow(st, rid, row, cache);
}

// ---------- State-wide tables ----------

function writeVv(db: Database.Database, state: SyncState): void {
  db.prepare('DELETE FROM sync_vv').run();
  const ins = db.prepare('INSERT INTO sync_vv (dev, hlc_ms, hlc_c) VALUES (?, ?, ?)');
  for (const [dev, stamp] of state.vv) ins.run(dev, stamp.ms, stamp.c);
}

function writeDevs(db: Database.Database, state: SyncState): void {
  db.prepare('DELETE FROM sync_dev').run();
  const ins = db.prepare('INSERT INTO sync_dev (dev, device_uuid, started_ms) VALUES (?, ?, ?)');
  for (const d of state.devs.values()) ins.run(d.dev, d.deviceUuid, d.startedMs);
}

function writeEpochs(db: Database.Database, state: SyncState): void {
  db.prepare('DELETE FROM sync_key_epoch').run();
  const ins = db.prepare(
    'INSERT INTO sync_key_epoch (epoch_id, parent_epoch, salt, verification, created_ms) VALUES (?, ?, ?, ?, ?)',
  );
  for (const e of state.epochs.values()) ins.run(e.epochId, e.parent, e.salt, e.verification, e.createdMs);
}

function writeWraps(db: Database.Database, state: SyncState): void {
  db.prepare('DELETE FROM sync_key_wrap').run();
  const ins = db.prepare('INSERT INTO sync_key_wrap (epoch_id, target_epoch, wrap) VALUES (?, ?, ?)');
  for (const w of state.wraps.values()) {
    if (w.wrap.length % 2 !== 0 || !/^[0-9a-f]*$/.test(w.wrap)) throw invariant('bad wrap hex');
    ins.run(w.epochId, w.targetEpoch, Buffer.from(w.wrap, 'hex'));
  }
}

/** Writes the replicated constants to sync_state (lineage_id, genesis_id, created_ms). */
export function writeStateHeader(db: Database.Database, state: SyncState): void {
  if (!Number.isSafeInteger(state.createdMs)) throw invariant('createdMs is not an integer');
  const upsert = db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  upsert.run(SYNC_STATE_KEYS.lineageId, state.lineageId);
  upsert.run(SYNC_STATE_KEYS.genesisId, state.genesisId);
  upsert.run(SYNC_STATE_KEYS.createdMs, String(state.createdMs));
}

function writeFileId(db: Database.Database, fileId: string | null | undefined): void {
  if (fileId === undefined) return;
  if (fileId === null) {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(SYNC_STATE_KEYS.fileId);
    return;
  }
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SYNC_STATE_KEYS.fileId, fileId);
}

// ---------- Full and diff rewrites ----------

function fullRewrite(db: Database.Database, st: Stmts, input: SaveInput): void {
  const { state, cache } = input;
  for (const t of REWRITTEN_TABLES) db.prepare(`DELETE FROM ${t}`).run();
  writeStateHeader(db, state);
  const keys = [...state.rows.keys()].sort();
  keys.forEach((k, i) => {
    const row = state.rows.get(k) as RowState;
    const rid = i + 1;
    st.insRowKey.run(rid, row.key.tbl, row.key.rowId);
    writeRow(st, rid, row, cache.get(k));
  });
  writeVv(db, state);
  writeDevs(db, state);
  writeEpochs(db, state);
  writeWraps(db, state);
}

function readRidMap(db: Database.Database): Map<string, number> {
  const rows = db.prepare('SELECT rid, tbl, row_id FROM sync_rowkey').raw().all() as Array<[number, Tbl, string]>;
  return new Map(rows.map(([rid, tbl, rowId]) => [rowKeyStr({ tbl, rowId }), rid] as const));
}

function sameCache(a: RowCacheEntry | undefined, b: RowCacheEntry | undefined): boolean {
  return (a?.materialized ?? false) === (b?.materialized ?? false) && (a?.rawHash ?? null) === (b?.rawHash ?? null);
}

function diffRows(st: Stmts, rids: Map<string, number>, input: SaveInput, baseline: LoadedFile): void {
  const { state, cache } = input;
  let maxRid = 0;
  for (const [k, rid] of rids) {
    maxRid = Math.max(maxRid, rid);
    if (state.rows.has(k)) continue;
    for (const del of st.delRowData) del.run(rid);
    st.delRowKey.run(rid);
  }
  const fresh: string[] = [];
  for (const [k, row] of state.rows) {
    const rid = rids.get(k);
    if (rid === undefined) fresh.push(k);
    else if (row !== baseline.state.rows.get(k) || !sameCache(cache.get(k), baseline.cache.get(k))) {
      rewriteRow(st, rid, row, cache.get(k));
    }
  }
  for (const k of fresh.sort()) {
    const row = state.rows.get(k) as RowState;
    maxRid += 1;
    st.insRowKey.run(maxRid, row.key.tbl, row.key.rowId);
    writeRow(st, maxRid, row, cache.get(k));
  }
}

function diffRewrite(db: Database.Database, st: Stmts, input: SaveInput, baseline: LoadedFile): void {
  const { state } = input;
  const base = baseline.state;
  if (state.lineageId !== base.lineageId || state.genesisId !== base.genesisId || state.createdMs !== base.createdMs) {
    writeStateHeader(db, state);
  }
  const rowsUnchanged = state.rows === base.rows && input.cache === baseline.cache;
  if (!rowsUnchanged) diffRows(st, readRidMap(db), input, baseline);
  if (state.vv !== base.vv) writeVv(db, state);
  if (state.devs !== base.devs) writeDevs(db, state);
  if (state.epochs !== base.epochs) writeEpochs(db, state);
  if (state.wraps !== base.wraps) writeWraps(db, state);
}

/**
 * One IMMEDIATE transaction with PRAGMA defer_foreign_keys = ON: applyWritePlan, then the sync
 * tables. Throws (and rolls back) on any error.
 */
export function saveState(db: Database.Database, input: SaveInput): void {
  const run = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    if (input.plan !== null) applyWritePlan(db, input.plan);
    const st = prepare(db);
    if (input.baseline === null) fullRewrite(db, st, input);
    else diffRewrite(db, st, input, input.baseline);
    writeFileId(db, input.fileId);
  });
  run.immediate();
}
