// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { regKey, rowKey } from '../catalog.js';
import { loadFile, saveState } from '../state-store.js';
import { StateBuilder, getRegister } from '../state-view.js';
import { TBL, type RowKey, type SyncState } from '../types.js';
import { app, bytes, materializeRows, newState, openVault, pseudo, setRow, type TempVault } from './state-store-fixtures.js';

const ENTRIES = 5000;
const FOLDERS = 50;
// Spec 13.3 budgets with generous headroom against CI noise.
const LOAD_BUDGET_MS = 150 * 3;
const DIFF_SAVE_BUDGET_MS = 20 * 3;
const FULL_SAVE_BUDGET_MS = 300 * 3;

const vaults: TempVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
});

function bigState(): { state: SyncState; live: RowKey[] } {
  const b = newState();
  const live: RowKey[] = [];
  for (let f = 0; f < FOLDERS; f++) {
    const id = `folder-${f}`;
    setRow(b, { tbl: TBL.folders, id, regs: { name: { sibs: [pseudo(0, `fn${f}`, `Folder ${f}`, { lt: f })] } } });
    live.push(rowKey(TBL.folders, id));
  }
  for (let i = 0; i < ENTRIES; i++) {
    const id = `entry-${String(i).padStart(5, '0')}`;
    const g = (reg: string, value: string | number | Buffer) => ({ sibs: [pseudo(0, `${id}:${reg}`, value, { lt: i })] });
    setRow(b, {
      tbl: TBL.entries,
      id,
      regs: {
        name: g('name', `Server ${i}`),
        entry_type: g('entry_type', 'ssh'),
        container: g('container', `f:folder-${i % FOLDERS}`),
        host: g('host', `host-${i}.example.com`),
        port: g('port', 22),
        username: g('username', 'admin'),
        password: g('password', bytes(`pw${i}`)),
        'config.theme': g('config.theme', '"dark"'),
        'tag:prod': g('tag:prod', 1),
        created_at: g('created_at', '2025-01-01T00:00:00.000Z'),
      },
    });
    live.push(rowKey(TBL.entries, id));
  }
  return { state: b.build(), live };
}

describe('state-store performance (13.3)', () => {
  it(`loads and diff-saves ${ENTRIES} entries within budget`, () => {
    const v = openVault();
    vaults.push(v);
    const { state, live } = bigState();
    const m = materializeRows(state, live);

    let t = performance.now();
    saveState(v.db, { state, plan: m.plan, cache: m.cache, baseline: null });
    const fullSaveMs = performance.now() - t;

    t = performance.now();
    const loaded = loadFile(v.db);
    const loadMs = performance.now() - t;
    expect(loaded.state).toEqual(state);

    const key = regKey(TBL.entries, 'entry-02500', 'host');
    const b = new StateBuilder(loaded.state);
    b.setRegister({ ...getRegister(loaded.state, key)!, sibs: [app(1, 10_000, 'moved.example.com')] });
    b.joinVv(1, { ms: 10_000, c: 0 });
    const next = b.build();
    const cache = new Map(loaded.cache);
    cache.set('1:entry-02500', { materialized: false, rawHash: null });
    t = performance.now();
    saveState(v.db, { state: next, plan: null, cache, baseline: loaded });
    const diffSaveMs = performance.now() - t;

    console.info(`[perf] full save ${fullSaveMs.toFixed(1)} ms, load ${loadMs.toFixed(1)} ms, diff save ${diffSaveMs.toFixed(1)} ms`);
    expect(loadMs).toBeLessThan(LOAD_BUDGET_MS);
    expect(diffSaveMs).toBeLessThan(DIFF_SAVE_BUDGET_MS);
    expect(fullSaveMs).toBeLessThan(FULL_SAVE_BUDGET_MS);
    expect(getRegister(loadFile(v.db).state, key)?.sibs[0].value).toBe('moved.example.com');
  });
});
