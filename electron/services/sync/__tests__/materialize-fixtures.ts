import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { implicitSiblingOf, regKey } from '../catalog.js';
import { isPseudo, makePmem } from '../sibling.js';
import { StateBuilder, emptyState, makeRegister } from '../state-view.js';
import { CREATE_SCHEMA } from '../../vault/schema.js';
import { SYNC_DDL } from '../schema.js';
import type {
  ContentSnapshot,
  EntryRow,
  FolderRow,
  Grave,
  HistoryRow,
  ImplicitProvider,
  Sibling,
  SyncState,
  SyncValue,
  Tbl,
} from '../types.js';

export const LINEAGE = 'lineage-1';
export const GENESIS = 'genesis-1';
export const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
export const CREATED = '2025-12-01T00:00:00.000Z';

export function vh(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export const implicit: ImplicitProvider = (key) => implicitSiblingOf(key, vh(`implicit:${key.reg}`));

export function app(dev: number, ms: number, value: SyncValue, opts: { c?: number; flags?: number } = {}): Sibling {
  return { dev, ms, c: opts.c ?? 0, pid: '', lt: 0, vhash: vh(`${dev}:${ms}:${String(value)}`), flags: opts.flags ?? 0, value, prevVhash: null };
}

export function pseudo(ms: number, lt: number, seed: string, value: SyncValue): Sibling {
  return { dev: 0, ms, c: 0, pid: vh(`pid:${seed}`), lt, vhash: vh(`v:${String(value)}`), flags: 0, value, prevVhash: null };
}

export interface RowSpec {
  readonly tbl: Tbl;
  readonly id: string;
  readonly regs?: Readonly<Record<string, Sibling | readonly Sibling[]>>;
  readonly grave?: Grave | null;
}

function pmemFor(sibs: readonly Sibling[]): ReturnType<typeof makePmem> | null {
  const pseudos = sibs.filter(isPseudo);
  if (pseudos.length === 0) return null;
  const ms = Math.max(...pseudos.map((s) => s.ms));
  return makePmem(ms, pseudos.filter((s) => s.ms === ms).map((s) => s.pid));
}

/** Builds a state from row specs (rows in the given order); vv covers every app sibling. */
export function buildState(specs: readonly RowSpec[], base: SyncState = emptyState(LINEAGE, GENESIS, 0)): SyncState {
  const b = new StateBuilder(base);
  for (const spec of specs) {
    b.ensureRow({ tbl: spec.tbl, rowId: spec.id });
    for (const [reg, value] of Object.entries(spec.regs ?? {})) {
      const sibs = Array.isArray(value) ? (value as readonly Sibling[]) : [value as Sibling];
      b.setRegister(makeRegister(regKey(spec.tbl, spec.id, reg), sibs, pmemFor(sibs)));
      for (const s of sibs) if (!isPseudo(s)) b.joinVv(s.dev, s);
    }
    if (spec.grave !== undefined) b.setGrave({ tbl: spec.tbl, rowId: spec.id }, spec.grave);
  }
  return b.build();
}

type Fields = Readonly<Record<string, SyncValue>>;

function regsAt(fields: Fields, life: string, dev: number, ms: number): Record<string, Sibling> {
  const regs: Record<string, Sibling> = { _life: app(dev, ms, life) };
  for (const [reg, v] of Object.entries(fields)) regs[reg] = app(dev, ms, v);
  return regs;
}

export function entry(id: string, fields: Fields, ms = T0, dev = 1): RowSpec {
  return { tbl: 1, id, regs: regsAt({ name: id, entry_type: 'ssh', created_at: CREATED, ...fields }, 'live', dev, ms) };
}

export function folder(id: string, fields: Fields, ms = T0, dev = 1): RowSpec {
  return { tbl: 2, id, regs: regsAt({ name: id, created_at: CREATED, ...fields }, 'live', dev, ms) };
}

export function history(id: string, entryId: string, fields: Fields = {}, ms = T0, dev = 1): RowSpec {
  return { tbl: 3, id, regs: regsAt({ entry_id: entryId, changed_at: CREATED, ...fields }, 'live', dev, ms) };
}

/** The same row with its `_life` replaced by one dead sibling. */
export function killed(spec: RowSpec, ms: number, dev = 1): RowSpec {
  return { ...spec, regs: { ...spec.regs, _life: app(dev, ms, 'dead') } };
}

export function entryRow(id: string, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id, name: id, entry_type: 'ssh', folder_id: null, parent_entry_id: null, sort_order: 0, host: null,
    port: null, credential_id: null, username: null, password_encrypted: null, domain: null,
    private_key_encrypted: null, totp_secret_encrypted: null, icon: null, color: null,
    credential_type: null, config: '{}', tags: '[]', is_favorite: 0, notes: null, created_at: CREATED,
    updated_at: CREATED, ...over,
  };
}

export function folderRow(id: string, over: Partial<FolderRow> = {}): FolderRow {
  return { id, name: id, parent_id: null, sort_order: 0, icon: null, color: null, created_at: CREATED, updated_at: CREATED, ...over };
}

export function historyRow(id: string, entryId: string, over: Partial<HistoryRow> = {}): HistoryRow {
  return { id, entry_id: entryId, username: null, password_encrypted: null, changed_at: CREATED, changed_by: null, ...over };
}

export function snapshot(
  rows: { entries?: EntryRow[]; folders?: FolderRow[]; history?: HistoryRow[]; meta?: Record<string, string> } = {},
): ContentSnapshot {
  return {
    entries: new Map((rows.entries ?? []).map((r) => [r.id, r])),
    folders: new Map((rows.folders ?? []).map((r) => [r.id, r])),
    history: new Map((rows.history ?? []).map((r) => [r.id, r])),
    meta: new Map(Object.entries(rows.meta ?? {})),
  };
}

export const EMPTY_CONTENT = snapshot();

// ---------- SQLite ----------

export interface TempVault {
  readonly db: Database.Database;
  readonly dir: string;
  close(): void;
}

/** A fresh desktop vault (CREATE_SCHEMA plus the sync DDL) with foreign keys ON. */
export function openTempVault(): TempVault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-materialize-'));
  const db = new Database(path.join(dir, 'v.conduit'));
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_SCHEMA);
  db.exec(SYNC_DDL);
  return {
    db,
    dir,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertRows(db: Database.Database, table: string, rows: readonly object[]): void {
  for (const row of rows) {
    const cols = Object.keys(row);
    const cells = Object.values(row).map((v) => (typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : v));
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(cells);
  }
}
