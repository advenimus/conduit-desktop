// @vitest-environment node
// Review finding 5 (spec 4.7): restore is an interactive write of `live` with the grave's
// values, so a concurrent "Delete permanently" on another device cannot erase the restored item.
import { afterEach, describe, expect, it } from 'vitest';
import { applyLocalWrites } from '../capture-local.js';
import { regKey, rowKey } from '../catalog.js';
import { deriveEpochKeys } from '../hashing.js';
import { merge } from '../merge.js';
import { isRedacted } from '../sibling.js';
import { getRegister, provisional } from '../state-view.js';
import { deletePermanently, restoreWrites } from '../tombstones.js';
import { TBL, type SyncContext } from '../types.js';
import { entryRow, historyIds } from './core-e2e-fixtures.js';
import { LINEAGE, T0, app, buildState, entry, history, implicit, killed } from './materialize-fixtures.js';
import { advance, converge, setupWorld, teardownWorld, type World } from './sim-world.js';

let w: World | null = null;
afterEach(() => {
  teardownWorld(w);
  w = null;
});

describe('restoreWrites (finding 5)', () => {
  const keys = deriveEpochKeys(Buffer.alloc(32, 7), LINEAGE);
  const ctx: SyncContext = {
    deviceUuid: '00000000-0000-4000-8000-000000000001',
    lineageId: LINEAGE,
    dev: 42,
    incarnation: 'ab'.repeat(16),
    keys: { current: keys, byEpoch: new Map([[keys.epochId, keys]]) },
    now: () => T0,
    randomBytes: (n) => Buffer.alloc(n, 1),
  };

  it("re-writes each register's provisional value, keeping an open conflict open", () => {
    const spec = entry('E', { notes: 'n' });
    const conflicted = { ...spec, regs: { ...spec.regs, host: [app(1, T0, 'h-new'), app(2, T0 - 1, 'h-old')] } };
    const state = buildState([killed(conflicted, T0 + 1)]);
    const writes = restoreWrites(state, [rowKey(TBL.entries, 'E')], ctx);
    const byReg = new Map(writes.map((x) => [x.key.reg, x]));
    expect(byReg.get('_life')).toMatchObject({ value: 'live', mode: 'replace-all' });
    expect(byReg.get('host')).toMatchObject({ value: 'h-new', mode: 'replace-provisional' });
    expect(byReg.get('notes')).toMatchObject({ value: 'n', mode: 'replace-provisional' });
    const hostSib = getRegister(state, regKey(TBL.entries, 'E', 'host'))!.sibs.find((s) => s.value === 'h-new')!;
    expect(byReg.get('host')?.vhash).toBe(hostSib.vhash);
  });

  it("re-writes the entry's live password history, not dead history or other entries' history", () => {
    const state = buildState([
      killed(entry('E', {}), T0 + 1),
      history('H1', 'E', { username: 'u', password: Buffer.from('old') }),
      killed(history('H2', 'E', { username: 'gone' }), T0 + 1),
      history('H3', 'Other', { username: 'x' }),
    ]);
    const writes = restoreWrites(state, [rowKey(TBL.entries, 'E')], ctx);
    const rows = new Set(writes.map((x) => x.key.rowId));
    expect(rows).toEqual(new Set(['E', 'H1']));
    const h1 = writes.filter((x) => x.key.rowId === 'H1');
    expect(h1.map((x) => x.key.reg).sort()).toEqual(['changed_at', 'entry_id', 'password', 'username']);
    expect(h1.every((x) => x.mode === 'replace-provisional')).toBe(true);
  });

  it('a concurrent Delete permanently cannot erase the restored password history', () => {
    const state = buildState([killed(entry('E', {}), T0 + 1), history('H1', 'E', { username: 'u', password: Buffer.from('old') })]);
    const dot = { dev: 42, ms: T0 + 10, c: 0 };
    const restored = applyLocalWrites(state, restoreWrites(state, [rowKey(TBL.entries, 'E')], ctx), { kind: 'local', dot, interactive: true }, ctx, implicit);
    const erased = deletePermanently(state, [rowKey(TBL.entries, 'E')]);
    const m = merge(restored.state, erased, implicit).state;
    for (const reg of ['username', 'password']) {
      const sibs = getRegister(m, regKey(TBL.history, 'H1', reg))!.sibs;
      expect(sibs.some(isRedacted)).toBe(false);
      expect(provisional(reg, sibs)?.value).toEqual(reg === 'password' ? Buffer.from('old') : 'u');
    }
  });

  it('keeps the restored item when another device concurrently deletes it permanently', () => {
    w = setupWorld();
    const { a, b } = w;
    const { web } = w.fixture.ids;
    advance(w);
    a.edit((v) => v.deleteEntry(web), true);
    converge(w);
    expect(entryRow(b.db, web)).toBeUndefined();
    advance(w);
    b.write(restoreWrites(b.state, [rowKey(TBL.entries, web)], b.ctx));
    const restored = { name: 'web', host: '10.0.0.1', username: 'root' };
    expect(entryRow(b.db, web)).toMatchObject(restored);
    advance(w);
    a.commit(deletePermanently(a.state, [rowKey(TBL.entries, web)]));
    converge(w);
    expect(entryRow(b.db, web)).toMatchObject(restored);
    expect(entryRow(a.db, web)).toMatchObject(restored);
    expect(b.vault.getEntry(web)?.password).toBe('pw-web');
    const { webHistory } = w.fixture.ids;
    for (const dev of [a, b]) expect(historyIds(dev.db)).toContain(webHistory);
    expect(b.vault.getPasswordHistoryEntry(webHistory)).toMatchObject({ username: 'root', password: 'pw-web-old' });
  });
});
