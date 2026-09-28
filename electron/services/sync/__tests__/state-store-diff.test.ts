// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { regKey, rowKey } from '../catalog.js';
import { loadFile, saveState } from '../state-store.js';
import { StateBuilder, getRegister, rowKeyStr } from '../state-view.js';
import { TBL, type LoadedFile, type RowCacheEntry } from '../types.js';
import { app, countRows, hex, openVault, totalChanges, type TempVault } from './state-store-fixtures.js';
import { richFixture } from './state-store-rich.js';

const vaults: TempVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
});

function savedVault(): { v: TempVault; loaded: LoadedFile } {
  const v = openVault();
  vaults.push(v);
  const fx = richFixture();
  saveState(v.db, { state: fx.state, plan: fx.plan, cache: fx.cache, baseline: null });
  return { v, loaded: loadFile(v.db) };
}

/** Every sync_reg and sync_sibling row as text, keyed by row id. */
function syncRowsById(v: TempVault): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sql = `SELECT k.row_id, 'reg', r.reg, hex(r.vhash), r.hlc_ms FROM sync_reg r JOIN sync_rowkey k USING (rid)
    UNION ALL SELECT k.row_id, 'sib', s.reg, hex(s.vhash), s.hlc_ms FROM sync_sibling s JOIN sync_rowkey k USING (rid)`;
  for (const [id, ...rest] of v.db.prepare(sql).raw().all() as string[][]) {
    const list = out.get(id) ?? [];
    list.push(rest.join('|'));
    out.set(id, list.sort());
  }
  return out;
}

function changedIds(before: Map<string, string[]>, after: Map<string, string[]>): string[] {
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))).sort();
}

describe('diff save with a baseline', () => {
  it('writes nothing when nothing changed', () => {
    const { v, loaded } = savedVault();
    const before = totalChanges(v.db);
    saveState(v.db, { state: loaded.state, plan: null, cache: loaded.cache, baseline: loaded });
    expect(totalChanges(v.db) - before).toBe(0);
  });

  it('rewrites only the row whose RowState changed', () => {
    const { v, loaded } = savedVault();
    const key = regKey(TBL.entries, 'e1', 'port');
    const b = new StateBuilder(loaded.state);
    b.setRegister({ ...getRegister(loaded.state, key)!, sibs: [app(1, 3000, 2222)] });
    b.joinVv(1, { ms: 3000, c: 0 });
    const next = b.build();
    const cache = new Map(loaded.cache);
    cache.set(rowKeyStr(rowKey(TBL.entries, 'e1')), { materialized: false, rawHash: null });
    const before = syncRowsById(v);
    const changesBefore = totalChanges(v.db);
    saveState(v.db, { state: next, plan: null, cache, baseline: loaded });
    const e1Regs = next.rows.get(rowKeyStr(rowKey(TBL.entries, 'e1')))!.regs.size;
    expect(changedIds(before, syncRowsById(v))).toEqual(['e1']);
    // e1 is rewritten (delete + insert with carriers now); vv is rewritten; nothing else.
    expect(totalChanges(v.db) - changesBefore).toBeLessThan(6 * e1Regs + 10);
    expect(loadFile(v.db).state).toEqual(next);
  });

  it('rewrites a row whose cache entry alone changed', () => {
    const { v, loaded } = savedVault();
    const k = rowKeyStr(rowKey(TBL.folders, 'f1'));
    const cache = new Map<string, RowCacheEntry>(loaded.cache);
    cache.set(k, { materialized: true, rawHash: hex('new-raw') });
    saveState(v.db, { state: loaded.state, plan: null, cache, baseline: loaded });
    expect(loadFile(v.db).cache.get(k)).toEqual({ materialized: true, rawHash: hex('new-raw') });
  });

  it('deletes the sync rows of rows that left the state', () => {
    const { v, loaded } = savedVault();
    const rows = new Map(loaded.state.rows);
    const gone = rowKeyStr(rowKey(TBL.entries, 'd1'));
    rows.delete(gone);
    const next = { ...loaded.state, rows };
    const regsBefore = countRows(v.db, 'sync_reg');
    saveState(v.db, { state: next, plan: null, cache: loaded.cache, baseline: loaded });
    expect(countRows(v.db, 'sync_reg')).toBe(regsBefore - loaded.state.rows.get(gone)!.regs.size);
    expect(countRows(v.db, 'sync_grave')).toBe(1);
    expect(v.db.prepare("SELECT COUNT(*) AS n FROM sync_rowkey WHERE row_id = 'd1'").get()).toEqual({ n: 0 });
    expect(loadFile(v.db).state).toEqual(next);
  });

  it('rewrites the state-wide tables only when their maps changed', () => {
    const { v, loaded } = savedVault();
    const b = new StateBuilder(loaded.state);
    b.addDev({ dev: 3, deviceUuid: 'uuid-3', startedMs: 5 });
    const next = b.build();
    const before = totalChanges(v.db);
    saveState(v.db, { state: next, plan: null, cache: loaded.cache, baseline: loaded });
    // sync_dev: 2 deletes + 3 inserts.
    expect(totalChanges(v.db) - before).toBe(5);
    expect(loadFile(v.db).state.devs.get(3)).toEqual({ dev: 3, deviceUuid: 'uuid-3', startedMs: 5 });
  });

  it('matches a from-scratch save', () => {
    const { v, loaded } = savedVault();
    const b = new StateBuilder(loaded.state);
    b.setGrave(rowKey(TBL.entries, 'd1'), { diedMs: 2000, diedC: 0, diedDev: 1, redacted: true });
    const next = b.build();
    saveState(v.db, { state: next, plan: null, cache: loaded.cache, baseline: loaded });
    const viaDiff = loadFile(v.db);
    saveState(v.db, { state: next, plan: null, cache: loaded.cache, baseline: null });
    expect(loadFile(v.db)).toEqual(viaDiff);
  });
});
