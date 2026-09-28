// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EPOCH_ZERO_ISO, IMPLICIT_PMEM, regKey } from '../catalog.js';
import { canonicalDump } from '../digest.js';
import { merge } from '../merge.js';
import { formatIsoMs } from '../canonical.js';
import { rawHash } from '../hashing.js';
import { computeUpdatedAt, materialize, resolveContainers, type MaterializeContext } from '../materialize.js';
import { StateBuilder, getRegister, makeRegister, rowKeyStr } from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, type EpochRecord, type RowCache, type SyncState } from '../types.js';
import {
  CREATED,
  EMPTY_CONTENT,
  T0,
  app,
  buildState,
  entry,
  entryRow,
  folder,
  folderRow,
  history,
  historyRow,
  implicit,
  killed,
  pseudo,
  snapshot,
  type RowSpec,
} from './materialize-fixtures.js';

const MCTX: MaterializeContext = { implicit, currentEpoch: null };
const NO_CACHE: RowCache = new Map();
const k = (tbl: 1 | 2 | 3 | 4, id: string): string => rowKeyStr({ tbl, rowId: id });
const matOf = (s: SyncState, tbl: 1 | 2 | 3 | 4, id: string, reg: string) => getRegister(s, regKey(tbl, id, reg))?.mat;

describe('rows and values (4.6 steps 1, 2)', () => {
  it('inserts live folders and entries with provisional values, updated_at and cache', () => {
    const state = buildState([folder('F', {}), entry('E', { container: 'f:F', host: 'h1', port: 22, 'config.a': '{"x":1}', 'tag:t': 1 })]);
    const m = materialize(state, EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(m.plan.upsertFolders.map((r) => r.id)).toEqual(['F']);
    const e = m.plan.upsertEntries[0];
    expect(e).toMatchObject({ id: 'E', folder_id: 'F', parent_entry_id: null, host: 'h1', port: 22, config: '{"a":{"x":1}}', tags: '["t"]' });
    expect(e.updated_at).toBe(formatIsoMs(T0));
    expect(m.cache.get(k(1, 'E'))).toEqual({ materialized: true, rawHash: rawHash(1, e) });
    expect(m.changedRows).toEqual([{ tbl: 2, rowId: 'F' }, { tbl: 1, rowId: 'E' }]);
    expect(m.state).toBe(state);
  });

  it('keeps canonically equal rows untouched (GRDB timestamp, empty host, non-JCS config)', () => {
    const state = buildState([entry('E', { created_at: '2025-12-01 00:00:00', 'config.a': '1', 'config.b': '2' })]);
    const cur = entryRow('E', { host: '', config: '{"b": 2, "a": 1}', tags: null, updated_at: 'stored' });
    const m = materialize(state, snapshot({ entries: [cur] }), NO_CACHE, MCTX);
    expect(m.plan.upsertEntries).toEqual([]);
    expect(m.changedRows).toEqual([]);
    expect(m.cache.get(k(1, 'E'))).toEqual({ materialized: true, rawHash: rawHash(1, cur) });
    expect(m.state).toBe(state);
  });

  it('compares bigint cells by integer value and never throws on mixed cell types', () => {
    const state = buildState([entry('E', { sort_order: 5, port: 22 })]);
    const same = entryRow('E', { sort_order: BigInt(5), port: BigInt(22) });
    expect(materialize(state, snapshot({ entries: [same] }), NO_CACHE, MCTX).plan.upsertEntries).toEqual([]);
    const legacyText = entryRow('E', { sort_order: BigInt(5), port: 'abc' });
    expect(materialize(state, snapshot({ entries: [legacyText] }), NO_CACHE, MCTX).plan.upsertEntries[0]).toMatchObject({ port: 22 });
  });

  it('rewrites a row whose register differs and derives updated_at from the newest dot', () => {
    const state = buildState([{ ...entry('E', {}, T0), regs: { ...entry('E', {}, T0).regs, host: app(2, T0 + 5000, 'new') } }]);
    const m = materialize(state, snapshot({ entries: [entryRow('E', { host: 'old' })] }), NO_CACHE, MCTX);
    expect(m.plan.upsertEntries).toHaveLength(1);
    expect(m.plan.upsertEntries[0]).toMatchObject({ host: 'new', updated_at: formatIsoMs(T0 + 5000) });
  });

  it('deletes current rows the state does not materialize, including unknown rows', () => {
    const state = buildState([killed(entry('D', {}), T0 + 1), folder('F', {})]);
    const cur = snapshot({ entries: [entryRow('D'), entryRow('X')], folders: [folderRow('F')] });
    const m = materialize(state, cur, NO_CACHE, MCTX);
    expect(m.plan.deleteEntries).toEqual(['D', 'X']);
    expect(m.cache.get(k(1, 'D'))).toEqual({ materialized: false, rawHash: null });
    expect(m.cache.has(k(1, 'X'))).toBe(false);
  });

  it('materializes redacted-only and undecryptable-only registers as defaults with NOT NULL fallbacks', () => {
    const red = (ms: number) => app(1, ms, null, { flags: SIB_REDACTED });
    const spec: RowSpec = {
      tbl: 1,
      id: 'E',
      regs: { _life: app(3, T0 + 9, 'live'), name: red(T0), entry_type: red(T0), created_at: red(T0), host: red(T0), password: app(1, T0, Buffer.from('ct'), { flags: SIB_UNDECRYPTABLE }) },
    };
    const m = materialize(buildState([spec]), EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(m.plan.upsertEntries[0]).toMatchObject({ name: '', entry_type: 'document', created_at: EPOCH_ZERO_ISO, host: null, password_encrypted: null });
    expect(matOf(m.state, 1, 'E', 'name')).toEqual({ value: '' });
    expect(matOf(m.state, 1, 'E', 'entry_type')).toEqual({ value: 'document' });
    expect(matOf(m.state, 1, 'E', 'created_at')).toEqual({ value: EPOCH_ZERO_ISO });
    expect(matOf(m.state, 1, 'E', 'host')).toBeUndefined();
    expect(matOf(m.state, 1, 'E', 'password')).toEqual({ value: null });
  });
});

describe('containers (4.6 step 3)', () => {
  it('sends dangling targets to root and keeps the logical value in the register', () => {
    const state = buildState([
      killed(folder('Dead', {}), T0 + 1),
      entry('E1', { container: 'f:Dead' }),
      entry('E2', { container: 'e:Nobody' }),
      folder('F1', { container: 'e:E1' }),
      folder('F2', { container: 'f:Dead' }),
    ]);
    const m = materialize(state, EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(m.plan.upsertEntries.map((r) => [r.id, r.folder_id, r.parent_entry_id])).toEqual([
      ['E1', null, null],
      ['E2', null, null],
    ]);
    expect(m.plan.upsertFolders.map((r) => [r.id, r.parent_id])).toEqual([
      ['F1', null],
      ['F2', null],
    ]);
    expect(matOf(m.state, 1, 'E1', 'container')).toEqual({ value: 'r' });
    expect(getRegister(m.state, regKey(1, 'E1', 'container'))?.sibs[0].value).toBe('f:Dead');
    expect(m.state.rows.get(k(2, 'Dead'))?.grave).toEqual({ diedMs: T0 + 1, diedC: 0, diedDev: 1, redacted: false });
  });

  it('breaks a folder cycle at the highest-ranked mover, deterministically across row orders', () => {
    const specs = [
      folder('A', { container: 'f:B' }, T0 + 200, 1),
      folder('B', { container: 'f:C' }, T0 + 300, 2),
      folder('C', { container: 'f:A' }, T0 + 100, 3),
      folder('S', { container: 'f:S' }),
    ];
    const one = materialize(buildState(specs), EMPTY_CONTENT, NO_CACHE, MCTX);
    const two = materialize(buildState([...specs].reverse()), EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(one.structural).toEqual([
      { kind: 'cycle', tbl: 2, rowIds: ['A', 'B', 'C'], movedToRoot: 'B' },
      { kind: 'cycle', tbl: 2, rowIds: ['S'], movedToRoot: 'S' },
    ]);
    expect(two.structural).toEqual(one.structural);
    expect(two.plan).toEqual(one.plan);
    const parent = new Map(one.plan.upsertFolders.map((r) => [r.id, r.parent_id]));
    expect(Object.fromEntries(parent)).toEqual({ A: 'B', B: null, C: 'A', S: null });
    expect(matOf(one.state, 2, 'B', 'container')).toEqual({ value: 'r' });
  });

  it('produces the same plan, conflicts and state for both merge orders of concurrent moves', () => {
    const base = buildState([folder('A', {}), folder('B', {})]);
    const moved = (id: string, dev: number, ms: number, to: string): SyncState => {
      const b = new StateBuilder(base);
      b.setRegister(makeRegister(regKey(2, id, 'container'), [app(dev, ms, to)], IMPLICIT_PMEM));
      b.joinVv(dev, { ms, c: 0 });
      return b.build();
    };
    const r1 = moved('A', 2, T0 + 100, 'f:B');
    const r2 = moved('B', 3, T0 + 200, 'f:A');
    const m1 = materialize(merge(r1, r2, implicit).state, EMPTY_CONTENT, NO_CACHE, MCTX);
    const m2 = materialize(merge(r2, r1, implicit).state, EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(m1.structural).toEqual([{ kind: 'cycle', tbl: 2, rowIds: ['A', 'B'], movedToRoot: 'B' }]);
    expect(m2.structural).toEqual(m1.structural);
    expect(m2.plan).toEqual(m1.plan);
    expect(canonicalDump(m2.state)).toBe(canonicalDump(m1.state));
    expect(matOf(m1.state, 2, 'B', 'container')).toEqual({ value: 'r' });
  });

  it('breaks an entry cycle through parent_entry_id and ties on one dot by row id', () => {
    const state = buildState([entry('E1', { container: 'e:E2' }), entry('E2', { container: 'e:E1' }), entry('E3', { container: 'e:E1' })]);
    const res = resolveContainers(state);
    expect(res.cycles).toEqual([{ kind: 'cycle', tbl: 1, rowIds: ['E1', 'E2'], movedToRoot: 'E2' }]);
    expect(res.effective.get(k(1, 'E2'))).toBe('r');
    expect(res.effective.get(k(1, 'E1'))).toBe('e:E2');
    expect(res.effective.get(k(1, 'E3'))).toBe('e:E1');
  });

  it('ranks pseudo container siblings by lt when ms ties (genesis cycle)', () => {
    const state = buildState([
      { tbl: 2, id: 'A', regs: { container: pseudo(0, 500, 'a', 'f:B') } },
      { tbl: 2, id: 'B', regs: { container: pseudo(0, 900, 'b', 'f:A') } },
    ]);
    expect(resolveContainers(state).cycles[0].movedToRoot).toBe('B');
  });
});

describe('credential_id (4.6 step 4)', () => {
  it('keeps only references to live credential entries', () => {
    const state = buildState([
      entry('Cred', { entry_type: 'credential' }),
      killed(entry('DeadCred', { entry_type: 'credential' }), T0 + 1),
      entry('Ssh', {}),
      entry('A', { credential_id: 'Cred' }),
      entry('B', { credential_id: 'DeadCred' }),
      entry('C', { credential_id: 'Ssh' }),
    ]);
    const m = materialize(state, EMPTY_CONTENT, NO_CACHE, MCTX);
    const cred = Object.fromEntries(m.plan.upsertEntries.map((r) => [r.id, r.credential_id]));
    expect(cred).toMatchObject({ A: 'Cred', B: null, C: null });
    expect(matOf(m.state, 1, 'A', 'credential_id')).toBeUndefined();
    expect(matOf(m.state, 1, 'B', 'credential_id')).toEqual({ value: null });
  });
});

describe('history visibility', () => {
  it('hides history with its dead entry and brings it back on revival', () => {
    const live = buildState([entry('E', {}), history('H', 'E', { username: 'u' })]);
    const dead = buildState([killed(entry('E', {}), T0 + 1), history('H', 'E', { username: 'u' })]);
    const cur = snapshot({ entries: [entryRow('E')], history: [historyRow('H', 'E', { username: 'u' })] });
    const m = materialize(dead, cur, NO_CACHE, MCTX);
    expect(m.plan.deleteHistory).toEqual(['H']);
    expect(m.plan.deleteEntries).toEqual(['E']);
    expect(m.cache.get(k(3, 'H'))).toEqual({ materialized: false, rawHash: null });
    expect(m.state.rows.get(k(3, 'H'))?.grave).toBeNull();
    const back = materialize(live, snapshot(), NO_CACHE, MCTX);
    expect(back.plan.upsertHistory.map((r) => r.id)).toEqual(['H']);
  });
});

describe('mat bookkeeping (4.6 step 5)', () => {
  it('clears a stale mat and keeps register objects whose mat is unchanged', () => {
    const base = buildState([folder('F', {}), entry('E', { container: 'f:F' })]);
    const b = new StateBuilder(base);
    const reg = getRegister(base, regKey(1, 'E', 'container'));
    if (!reg) throw new Error('fixture');
    b.setRegister({ ...reg, mat: { value: 'r' } });
    const stale = b.build();
    const m = materialize(stale, EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(matOf(m.state, 1, 'E', 'container')).toBeUndefined();
    expect(m.state.rows.get(k(2, 'F'))).toBe(stale.rows.get(k(2, 'F')));
  });

  it('clears mats on rows that stop materializing', () => {
    const state = buildState([killed(entry('E', {}), T0 + 1)]);
    const reg = getRegister(state, regKey(1, 'E', 'host')) ?? makeRegister(regKey(1, 'E', 'host'), [app(1, T0, 'h')], null);
    const b = new StateBuilder(state);
    b.setRegister({ ...reg, mat: { value: 'x' } });
    const m = materialize(b.build(), EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(matOf(m.state, 1, 'E', 'host')).toBeUndefined();
  });
});

describe('graves (4.6 step 6)', () => {
  const dead = killed(entry('E', { host: 'h' }), T0 + 50, 2);

  it('records the provisional dead dot and clears the grave on revival', () => {
    const m = materialize(buildState([dead]), EMPTY_CONTENT, NO_CACHE, MCTX);
    expect(m.state.rows.get(k(1, 'E'))?.grave).toEqual({ diedMs: T0 + 50, diedC: 0, diedDev: 2, redacted: false });
    const revived = buildState([{ ...dead, regs: { ...dead.regs, _life: [app(2, T0 + 50, 'dead'), app(3, T0 + 60, 'live')] } }], m.state);
    expect(materialize(revived, EMPTY_CONTENT, NO_CACHE, MCTX).state.rows.get(k(1, 'E'))?.grave).toBeNull();
  });

  it('keeps a grave redacted only while every value sibling is redacted', () => {
    const redactedGrave = { diedMs: T0 + 50, diedC: 0, diedDev: 2, redacted: true };
    const erasedHost = app(1, T0, null, { flags: SIB_REDACTED });
    const graveOf = (spec: RowSpec) => materialize(buildState([spec]), EMPTY_CONTENT, NO_CACHE, MCTX).state.rows.get(k(1, 'E'))?.grave;

    const same = buildState([{ tbl: 1, id: 'E', regs: { _life: app(2, T0 + 50, 'dead'), host: erasedHost }, grave: redactedGrave }]);
    expect(materialize(same, EMPTY_CONTENT, NO_CACHE, MCTX).state).toBe(same);

    const twoDeletes = { _life: [app(2, T0 + 50, 'dead'), app(4, T0 + 70, 'dead')] };
    expect(graveOf({ tbl: 1, id: 'E', regs: { ...twoDeletes, host: erasedHost }, grave: redactedGrave })).toEqual({ diedMs: T0 + 70, diedC: 0, diedDev: 4, redacted: true });
    expect(graveOf({ ...dead, regs: { ...dead.regs, ...twoDeletes }, grave: redactedGrave })).toEqual({ diedMs: T0 + 70, diedC: 0, diedDev: 4, redacted: false });
    expect(graveOf({ ...dead, grave: redactedGrave })).toEqual({ ...redactedGrave, redacted: false });
  });
});

describe('vault_meta (4.6 step 6)', () => {
  const epoch: EpochRecord = { epochId: 'e'.repeat(32), parent: null, salt: 'SALT', verification: 'VER', createdMs: 0 };

  it('writes synced registers and the current epoch only when different', () => {
    const state = buildState([{ tbl: 4, id: 'meta', regs: { vault_id: app(1, T0, 'vid') } }]);
    const cur = snapshot({ meta: { vault_id: 'old', cloud_sync_enabled: 'true', salt: 'SALT', schema_version: '10', key_source: 'password' } });
    const m = materialize(state, cur, NO_CACHE, { implicit, currentEpoch: epoch });
    expect([...m.plan.meta]).toEqual([
      ['vault_id', 'vid'],
      ['cloud_sync_enabled', null],
      ['verification', 'VER'],
    ]);
  });

  it('leaves vault_meta alone when the meta row is unknown and no epoch is given', () => {
    const m = materialize(buildState([]), snapshot({ meta: { vault_id: 'x' } }), NO_CACHE, MCTX);
    expect(m.plan.meta.size).toBe(0);
  });
});

describe('computeUpdatedAt', () => {
  it('uses the newest provisional app ms or pseudo lt, then stored text, then the fallback', () => {
    const state = buildState([
      { tbl: 2, id: 'A', regs: { name: app(1, T0, 'a'), icon: pseudo(3, T0 + 10, 'i', 'x') } },
      { tbl: 2, id: 'G', regs: { name: pseudo(0, 0, 'g', 'g') } },
    ]);
    expect(computeUpdatedAt(state, k(2, 'A'), 'stored', 'fb')).toBe(formatIsoMs(T0 + 10));
    expect(computeUpdatedAt(state, k(2, 'G'), 'stored', 'fb')).toBe('stored');
    expect(computeUpdatedAt(state, k(2, 'G'), null, 'fb')).toBe('fb');
    expect(computeUpdatedAt(state, k(2, 'missing'), null, CREATED)).toBe(CREATED);
  });
});

describe('cache reuse', () => {
  it('reuses equal cache entries and returns the same cache map when nothing changed', () => {
    const state = buildState([entry('E', {})]);
    const first = materialize(state, EMPTY_CONTENT, NO_CACHE, MCTX);
    const row = first.plan.upsertEntries[0];
    const again = materialize(first.state, snapshot({ entries: [row] }), first.cache, MCTX);
    expect(again.cache).toBe(first.cache);
    expect(again.plan.upsertEntries).toEqual([]);
  });
});
