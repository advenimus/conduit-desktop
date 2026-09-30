// Shared fixtures for the state-store tests: temp vault files and hand-built SyncStates whose
// content rows are consistent with their head values (what materialize would have written).
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATE_SCHEMA } from '../../vault/schema.js';
import { TABLE_NAME, buildContentRow, isContentTbl, regKey, rowKey } from '../catalog.js';
import { ensureSyncSchema } from '../schema.js';
import { StateBuilder, emptyState, headOf, makeRegister, rowKeyStr } from '../state-view.js';
import {
  PSEUDO_DEV,
  TBL,
  type ContentRow,
  type ContentTbl,
  type EntryRow,
  type FolderRow,
  type Grave,
  type HistoryRow,
  type MatOverride,
  type Pmem,
  type RowCacheEntry,
  type RowKey,
  type Sibling,
  type SyncState,
  type SyncValue,
  type Tbl,
  type WritePlan,
} from '../types.js';

export const UPDATED_AT = '2026-02-03T04:05:06.007Z';

export interface TempVault {
  readonly db: Database.Database;
  readonly dir: string;
  close(): void;
}

export function openVault(opts: { sync?: boolean; schema?: string } = {}): TempVault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-store-'));
  const db = new Database(path.join(dir, 'vault.conduit'));
  db.pragma('foreign_keys = ON');
  db.exec(opts.schema ?? CREATE_SCHEMA);
  db.exec(
    "INSERT INTO vault_meta (key, value) VALUES ('schema_version', '10'), ('salt', 'c2FsdA=='), ('verification', 'dG9rZW4=')",
  );
  if (opts.sync !== false) ensureSyncSchema(db);
  return {
    db,
    dir,
    close() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const hex = (seed: string, len = 32): string =>
  crypto.createHash('sha256').update(seed).digest('hex').slice(0, len);

export const bytes = (seed: string, len = 40): Buffer =>
  Buffer.from(crypto.createHash('sha512').update(seed).digest().subarray(0, len));

interface SibOpts {
  readonly c?: number;
  readonly flags?: number;
  readonly vhash?: string;
  readonly prev?: string | null;
  readonly lt?: number;
}

export function app(dev: number, ms: number, value: SyncValue, o: SibOpts = {}): Sibling {
  return {
    dev,
    ms,
    c: o.c ?? 0,
    pid: '',
    lt: 0,
    vhash: o.vhash ?? hex(`v:${dev}:${ms}:${String(value)}`),
    flags: o.flags ?? 0,
    value,
    prevVhash: o.prev ?? null,
  };
}

export function pseudo(ms: number, pidSeed: string, value: SyncValue, o: SibOpts = {}): Sibling {
  return {
    dev: PSEUDO_DEV,
    ms,
    c: 0,
    pid: hex(`pid:${pidSeed}`),
    lt: o.lt ?? 0,
    vhash: o.vhash ?? hex(`pv:${pidSeed}:${String(value)}`),
    flags: o.flags ?? 0,
    value,
    prevVhash: null,
  };
}

/** The pmem sync_reg derives for a pseudo head. */
export const derived = (s: Sibling): Pmem => ({ ms: s.ms, ids: [s.pid] });

export interface RegSpec {
  readonly sibs: readonly Sibling[];
  readonly pmem?: Pmem | null;
  readonly mat?: MatOverride;
}

export interface RowSpec {
  readonly tbl: Tbl;
  readonly id: string;
  readonly regs: Readonly<Record<string, RegSpec>>;
  readonly grave?: Grave | null;
}

export function setRow(b: StateBuilder, spec: RowSpec): void {
  const rk = rowKey(spec.tbl, spec.id);
  b.ensureRow(rk);
  for (const [reg, r] of Object.entries(spec.regs)) {
    const pmem = r.pmem === undefined ? defaultPmem(r.sibs) : r.pmem;
    const base = makeRegister(regKey(spec.tbl, spec.id, reg), r.sibs, pmem);
    b.setRegister(r.mat === undefined ? base : { ...base, mat: r.mat });
  }
  if (spec.grave !== undefined) b.setGrave(rk, spec.grave);
}

function defaultPmem(sibs: readonly Sibling[]): Pmem | null {
  const pseudos = sibs.filter((s) => s.dev === PSEUDO_DEV);
  if (pseudos.length === 0) return null;
  const ms = Math.max(...pseudos.map((s) => s.ms));
  return { ms, ids: pseudos.filter((s) => s.ms === ms).map((s) => s.pid).sort() };
}

/** Materialized values of a row: mat when set, else the head's logical value. */
export function materializedValues(state: SyncState, rk: RowKey): Map<string, SyncValue> {
  const row = state.rows.get(rowKeyStr(rk));
  const out = new Map<string, SyncValue>();
  for (const [name, reg] of row?.regs ?? []) {
    out.set(name, reg.mat ? reg.mat.value : (headOf(name, reg.sibs) as Sibling).value);
  }
  return out;
}

export interface Materialized {
  readonly plan: WritePlan;
  readonly cache: Map<string, RowCacheEntry>;
}

/** Plan + cache as materialize would produce when exactly `live` rows (tbl 1-4) are materialized. */
export function materializeRows(state: SyncState, live: readonly RowKey[]): Materialized {
  const folders: FolderRow[] = [];
  const entries: EntryRow[] = [];
  const history: HistoryRow[] = [];
  const meta = new Map<string, string | null>();
  const liveKeys = new Set(live.map(rowKeyStr));
  for (const rk of live) {
    const values = materializedValues(state, rk);
    if (rk.tbl === TBL.meta) {
      for (const [k, v] of values) meta.set(k, v === null ? null : String(v));
      continue;
    }
    const row = buildContentRow(rk.tbl as ContentTbl, rk.rowId, values, UPDATED_AT);
    const bucket: ContentRow[] = rk.tbl === TBL.folders ? folders : rk.tbl === TBL.entries ? entries : history;
    bucket.push(row);
  }
  const cache = new Map<string, RowCacheEntry>();
  for (const [k, row] of state.rows) {
    if (!isContentTbl(row.key.tbl)) continue;
    cache.set(k, liveKeys.has(k) ? { materialized: true, rawHash: hex(`raw:${k}`) } : { materialized: false, rawHash: null });
  }
  const plan: WritePlan = {
    upsertFolders: folders,
    upsertEntries: entries,
    upsertHistory: history,
    deleteHistory: [],
    deleteEntries: [],
    deleteFolders: [],
    meta,
  };
  return { plan, cache };
}

export function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

export const tableOf = (tbl: ContentTbl): string => TABLE_NAME[tbl];

export function newState(): StateBuilder {
  return new StateBuilder(emptyState(hex('lineage'), hex('genesis', 64), 1_700_000_000_000));
}
