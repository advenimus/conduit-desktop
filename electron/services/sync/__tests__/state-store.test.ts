// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { META_ROW_ID, SYNC_ROW, regKey, rowKey } from '../catalog.js';
import { loadFile, saveState } from '../state-store.js';
import { StateBuilder, getRegister, makeRegister, rowKeyStr } from '../state-view.js';
import { SyncCoreError, TBL, ZERO_PID, type SyncState } from '../types.js';
import { app, countRows, hex, materializeRows, newState, openVault, pseudo, setRow, type TempVault } from './state-store-fixtures.js';
import { LIVE_ROWS, richFixture } from './state-store-rich.js';

const vaults: TempVault[] = [];
function vault(opts?: Parameters<typeof openVault>[0]): TempVault {
  const v = openVault(opts);
  vaults.push(v);
  return v;
}

afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
});

function saveFresh(v: TempVault, fileId?: string | null) {
  const fx = richFixture();
  saveState(v.db, { state: fx.state, plan: fx.plan, cache: fx.cache, baseline: null, fileId });
  return fx;
}

function explicitCount(state: SyncState): number {
  let n = 0;
  for (const row of state.rows.values()) n += row.regs.size;
  return n;
}

function regRow(v: TempVault, tbl: number, rowId: string, reg: string): Record<string, unknown> {
  return v.db
    .prepare('SELECT r.* FROM sync_reg r JOIN sync_rowkey k ON k.rid = r.rid WHERE k.tbl = ? AND k.row_id = ? AND r.reg = ?')
    .get(tbl, rowId, reg) as Record<string, unknown>;
}

function siblingRows(v: TempVault, tbl: number, rowId: string, reg: string): Array<Record<string, unknown>> {
  return v.db
    .prepare(
      'SELECT s.*, typeof(s.value) AS cls FROM sync_sibling s JOIN sync_rowkey k ON k.rid = s.rid WHERE k.tbl = ? AND k.row_id = ? AND s.reg = ?',
    )
    .all(tbl, rowId, reg) as Array<Record<string, unknown>>;
}

describe('round trip (3.3)', () => {
  it('loads exactly the state, cache and file id it saved', () => {
    const v = vault();
    const fx = saveFresh(v, 'file-1');
    const loaded = loadFile(v.db);
    expect(loaded.state).toEqual(fx.state);
    expect(loaded.cache).toEqual(fx.cache);
    expect(loaded.fileId).toBe('file-1');
    expect(loaded.syncFormat).toBe(1);
    expect(loaded.content.entries.get('e1')?.host).toBe('b.example');
    expect(loaded.content.meta.get('vault_id')).toBe('vault-uuid-1');
    expect(loaded.content.meta.has('cloud_sync_enabled')).toBe(false);

    // The deep compare must see a single differing byte deep inside the maps.
    const key = regKey(TBL.entries, 'c1', 'password');
    const reg = getRegister(fx.state, key)!;
    const b = new StateBuilder(fx.state);
    b.setRegister({ ...reg, sibs: [{ ...reg.sibs[0], value: Buffer.from('other') }] });
    expect(loaded.state).not.toEqual(b.build());
  });

  it('stores only explicit registers; implicit ones have no rows', () => {
    const v = vault();
    const fx = saveFresh(v);
    expect(countRows(v.db, 'sync_reg')).toBe(explicitCount(fx.state));
    expect(countRows(v.db, 'sync_rowkey')).toBe(fx.state.rows.size);
    const f2 = v.db.prepare("SELECT COUNT(*) AS n FROM sync_reg r JOIN sync_rowkey k USING (rid) WHERE k.row_id = 'f2'").get();
    expect(f2).toEqual({ n: 0 });
    expect(loadFile(v.db).state.rows.get(rowKeyStr(rowKey(TBL.folders, 'f2')))?.regs.size).toBe(0);
  });

  it('stores an explicit register equal to its implicit form as implicit', () => {
    const v = vault();
    const fx = richFixture();
    const key = regKey(TBL.entries, 'e1', 'sort_order');
    const b = new StateBuilder(fx.state);
    b.setRegister(makeRegister(key, [pseudo(0, 'zero', 0)].map((s) => ({ ...s, pid: ZERO_PID })), { ms: 0, ids: [ZERO_PID] }));
    saveState(v.db, { state: b.build(), plan: fx.plan, cache: fx.cache, baseline: null });
    const loaded = loadFile(v.db);
    expect(getRegister(loaded.state, key)).toBeUndefined();
    expect(loaded.state).toEqual(fx.state);
  });

  it('keeps prev_vhash only on heads', () => {
    const v = vault();
    const fx = richFixture();
    const key = regKey(TBL.entries, 'e1', 'host');
    const reg = getRegister(fx.state, key);
    const b = new StateBuilder(fx.state);
    const sibs = reg!.sibs.map((s) => (s.dev === 1 ? { ...s, prevVhash: hex('lost', 16) } : s));
    b.setRegister({ ...reg!, sibs });
    saveState(v.db, { state: b.build(), plan: fx.plan, cache: fx.cache, baseline: null });
    const loaded = getRegister(loadFile(v.db).state, key)!;
    expect(loaded.sibs.find((s) => s.dev === 1)?.prevVhash).toBeNull();
    expect(loaded.sibs.find((s) => s.dev === 2)?.prevVhash).toBe(hex('h', 16));
  });
});

describe('where head values live', () => {
  it('writes carriers only where the home cannot hold the logical value', () => {
    const v = vault();
    saveFresh(v);
    const carriers = v.db
      .prepare(
        `SELECT k.tbl, k.row_id, s.reg FROM sync_sibling s JOIN sync_rowkey k USING (rid) JOIN sync_reg r USING (rid, reg)
         WHERE s.dev = r.dev AND s.hlc_ms = r.hlc_ms AND s.hlc_c = r.hlc_c AND s.pid = coalesce(r.pid, x'')
         ORDER BY k.tbl, k.row_id, s.reg`,
      )
      .raw()
      .all();
    expect(carriers).toEqual([
      [1, 'e2', 'container'],
      [1, 'e2', 'credential_id'],
      [1, 'r1', '_life'],
      [3, 'h1', '_life'],
      [3, 'h1', 'changed_at'],
      [3, 'h1', 'entry_id'],
      [3, 'h1', 'password'],
      [4, META_ROW_ID, 'cloud_sync_enabled'],
      [9, SYNC_ROW.device, 'uuid-1'],
      [9, SYNC_ROW.dismiss, hex('dismiss')],
      [9, SYNC_ROW.key, 'epoch'],
      [9, SYNC_ROW.owner, 'owner'],
    ]);
  });

  it('keeps dead rows in row_json and redacted graves without it', () => {
    const v = vault();
    saveFresh(v);
    const graves = v.db
      .prepare('SELECT k.row_id, g.row_json, g.redacted FROM sync_grave g JOIN sync_rowkey k USING (rid) ORDER BY k.row_id')
      .raw()
      .all() as Array<[string, string | null, number]>;
    expect(graves.map(([id, , r]) => [id, r])).toEqual([
      ['d1', 0],
      ['r1', 1],
    ]);
    expect(JSON.parse(graves[0][1]!)).toMatchObject({ _life: 'dead', name: 'Old', port: 3389 });
    expect(graves[1][1]).toBeNull();
    const r1 = loadFile(v.db).state.rows.get(rowKeyStr(rowKey(TBL.entries, 'r1')))!;
    expect(r1.regs.get('_life')?.sibs[0].value).toBe('dead');
    expect(r1.regs.get('host')?.sibs.map((s) => s.value)).toEqual([null, null]);
  });

  it('stores sibling values in their natural storage class', () => {
    const v = vault();
    const b = newState();
    setRow(b, {
      tbl: TBL.sync,
      id: SYNC_ROW.device,
      regs: { d: { sibs: [app(1, 10, 42), app(2, 11, 'text'), app(3, 12, Buffer.from([1, 2])), app(4, 13, null), app(5, 14, 1.5)] } },
    });
    b.joinVv(1, { ms: 20, c: 0 });
    for (const dev of [2, 3, 4, 5]) b.joinVv(dev, { ms: 20, c: 0 });
    const state = b.build();
    saveState(v.db, { state, plan: null, cache: new Map(), baseline: null });
    const cls = siblingRows(v, TBL.sync, SYNC_ROW.device, 'd').map((r) => [r.dev, r.cls]);
    expect(cls).toEqual([
      [1, 'integer'],
      [2, 'text'],
      [3, 'blob'],
      [4, 'null'],
      [5, 'real'],
    ]);
    expect(loadFile(v.db).state).toEqual(state);
  });

  it('keeps an undecryptable sibling with its ciphertext', () => {
    const v = vault();
    const fx = saveFresh(v);
    const key = regKey(TBL.entries, 'e1', 'password');
    expect(getRegister(loadFile(v.db).state, key)).toEqual(getRegister(fx.state, key));
    const rows = siblingRows(v, TBL.entries, 'e1', 'password');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dev: 0, flags: 1, cls: 'blob' });
  });
});

describe('pmem encoding', () => {
  it('stores NULL when the pmem equals the derived one, else explicit ids', () => {
    const v = vault();
    saveFresh(v);
    expect(regRow(v, TBL.entries, 'e1', 'name')).toMatchObject({ pmem_ms: null, pmem_ids: null });
    expect(regRow(v, TBL.entries, 'e1', '_life')).toMatchObject({ pmem_ms: null, pmem_ids: null });
    const user = regRow(v, TBL.entries, 'e1', 'username');
    expect(user.pmem_ms).toBe(5000);
    expect((user.pmem_ids as Buffer).length).toBe(32);
    const host = regRow(v, TBL.entries, 'e1', 'host');
    expect(host.pmem_ms).toBe(0);
    expect((host.pmem_ids as Buffer).toString('hex')).toBe(ZERO_PID);
  });

  it('round-trips an empty memory under a pseudo head', () => {
    const v = vault();
    const b = newState();
    setRow(b, { tbl: TBL.sync, id: SYNC_ROW.owner, regs: { owner: { sibs: [pseudo(7, 'x', '{}')], pmem: null } } });
    const state = b.build();
    saveState(v.db, { state, plan: null, cache: new Map(), baseline: null });
    expect(regRow(v, TBL.sync, SYNC_ROW.owner, 'owner')).toMatchObject({ pmem_ms: null });
    expect(loadFile(v.db).state).toEqual(state);
  });
});

describe('rids are per file', () => {
  it('assigns fresh rids in ascending row key order', () => {
    const v = vault();
    const fx = saveFresh(v);
    const rows = v.db.prepare('SELECT rid, tbl, row_id FROM sync_rowkey ORDER BY rid').raw().all() as Array<[number, number, string]>;
    expect(rows.map(([rid]) => rid)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.map(([, t, id]) => `${t}:${id}`)).toEqual([...fx.state.rows.keys()].sort());
  });

  it('keeps existing rids and gives new rows max + 1', () => {
    const v = vault();
    saveFresh(v);
    const loaded = loadFile(v.db);
    v.db.prepare("UPDATE sync_rowkey SET rid = rid + 100 WHERE row_id = 'e1'").run();
    for (const t of ['sync_reg', 'sync_sibling', 'sync_row']) {
      v.db.prepare(`UPDATE ${t} SET rid = rid + 100 WHERE rid = (SELECT rid - 100 FROM sync_rowkey WHERE row_id = 'e1')`).run();
    }
    const b = new StateBuilder(loaded.state);
    setRow(b, { tbl: TBL.entries, id: 'n1', regs: { _life: { sibs: [app(1, 2100, 'live')] } } });
    const next = b.build();
    saveState(v.db, { state: next, plan: null, cache: loaded.cache, baseline: loaded });
    const rid = (id: string) => (v.db.prepare('SELECT rid FROM sync_rowkey WHERE row_id = ?').get(id) as { rid: number }).rid;
    const e1 = rid('e1');
    expect(e1).toBeGreaterThan(100);
    expect(rid('n1')).toBe(e1 + 1);
    expect(loadFile(v.db).state).toEqual(next);
  });

  it('two files with different rids load the same state', () => {
    const a = vault();
    const b = vault();
    const fx = saveFresh(a);
    const extra = new StateBuilder(fx.state);
    setRow(extra, { tbl: TBL.entries, id: 'aaa', regs: { _life: { sibs: [app(1, 2100, 'dead')] } } });
    const withExtra = extra.build();
    const mb = materializeRows(withExtra, LIVE_ROWS);
    saveState(b.db, { state: withExtra, plan: mb.plan, cache: mb.cache, baseline: null });
    const lb = loadFile(b.db);
    saveState(b.db, { state: fx.state, plan: null, cache: fx.cache, baseline: lb });
    const ridOf = (t: TempVault) => (t.db.prepare("SELECT rid FROM sync_rowkey WHERE row_id = 'c1'").get() as { rid: number }).rid;
    expect(ridOf(a)).not.toBe(ridOf(b));
    expect(loadFile(b.db).state).toEqual(loadFile(a.db).state);
  });
});

describe('loadFile errors', () => {
  it('refuses files without sync tables', () => {
    const v = vault({ sync: false });
    expect(() => loadFile(v.db)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }));
  });

  it('reports a _sync head without its carrier as corrupt', () => {
    const v = vault();
    saveFresh(v);
    v.db.prepare("DELETE FROM sync_sibling WHERE reg = 'owner'").run();
    expect(() => loadFile(v.db)).toThrow(SyncCoreError);
    expect(() => loadFile(v.db)).toThrow(expect.objectContaining({ code: 'CORRUPT_STATE' }));
  });

  it('reports a missing header and orphan siblings as corrupt', () => {
    const v = vault();
    saveFresh(v);
    v.db.prepare("INSERT INTO sync_sibling (rid, reg, dev, hlc_ms, hlc_c, vhash) VALUES (999, 'x', 1, 1, 0, x'00')").run();
    expect(() => loadFile(v.db)).toThrow(expect.objectContaining({ code: 'CORRUPT_STATE' }));
    v.db.prepare('DELETE FROM sync_sibling WHERE rid = 999').run();
    v.db.prepare("DELETE FROM sync_state WHERE key = 'lineage_id'").run();
    expect(() => loadFile(v.db)).toThrow(expect.objectContaining({ code: 'CORRUPT_STATE' }));
  });

  it('loads a row a legacy app deleted, with unknown head values left for capture', () => {
    const v = vault();
    saveFresh(v);
    v.db.pragma('foreign_keys = OFF');
    v.db.prepare("DELETE FROM entries WHERE id = 'e2'").run();
    const loaded = loadFile(v.db);
    const e2 = loaded.state.rows.get(rowKeyStr(rowKey(TBL.entries, 'e2')))!;
    expect(loaded.cache.get(rowKeyStr(e2.key))?.materialized).toBe(true);
    expect(e2.regs.get('name')?.sibs[0].value).toBeNull();
    expect(e2.regs.get('container')?.sibs[0].value).toBe('f:gone');
  });
});

describe('file id', () => {
  it('is written when given, removed with null and kept otherwise', () => {
    const v = vault();
    const fx = saveFresh(v, 'f-1');
    const loaded = loadFile(v.db);
    saveState(v.db, { state: fx.state, plan: null, cache: fx.cache, baseline: loaded });
    expect(loadFile(v.db).fileId).toBe('f-1');
    saveState(v.db, { state: fx.state, plan: null, cache: fx.cache, baseline: null });
    expect(loadFile(v.db).fileId).toBe('f-1');
    saveState(v.db, { state: fx.state, plan: null, cache: fx.cache, baseline: loaded, fileId: null });
    expect(loadFile(v.db).fileId).toBeNull();
  });
});
