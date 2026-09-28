// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { applyLocalWrites } from '../capture-local.js';
import { regKey } from '../catalog.js';
import { deriveEpochKeys, vhashOfValue } from '../hashing.js';
import { materialize } from '../materialize.js';
import { merge } from '../merge.js';
import { getRegister, rowKeyStr } from '../state-view.js';
import {
  RECENTLY_DELETED_WINDOW_MS,
  deletePermanently,
  emptyRecentlyDeleted,
  hasRedactedFields,
  listRecentlyDeleted,
  restoreWrites,
} from '../tombstones.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, ZERO_VHASH, type Sibling, type SyncContext, type SyncState } from '../types.js';
import {
  EMPTY_CONTENT,
  LINEAGE,
  T0,
  app,
  buildState,
  entry,
  folder,
  history,
  implicit,
  killed,
  pseudo,
  type RowSpec,
} from './materialize-fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = T0 + 60 * DAY;
const k = (tbl: 1 | 2 | 3, id: string): string => rowKeyStr({ tbl, rowId: id });
const sibsOf = (s: SyncState, tbl: 1 | 2 | 3, id: string, reg: string): readonly Sibling[] =>
  getRegister(s, regKey(tbl, id, reg))?.sibs ?? [];

function redactedCopy(s: Sibling): Sibling {
  return { ...s, value: null, vhash: ZERO_VHASH, flags: s.flags | SIB_REDACTED, prevVhash: null };
}

describe('listRecentlyDeleted (4.7)', () => {
  const state = buildState([
    killed(entry('Old', { entry_type: 'rdp' }), NOW - 40 * DAY),
    { ...killed(entry('Graved', {}), NOW - 3 * DAY), grave: { diedMs: NOW - 2 * DAY, diedC: 0, diedDev: 7, redacted: false } },
    killed(folder('Dir', {}), NOW - 1 * DAY),
    killed(history('H', 'Old'), NOW - DAY),
    entry('Alive', {}),
  ]);

  it('lists dead entries and folders newest first within 30 days, grave time first', () => {
    const items = listRecentlyDeleted(state, NOW, false);
    expect(items.map((i) => [i.row.rowId, i.diedMs, i.diedDev, i.entryType])).toEqual([
      ['Dir', NOW - DAY, 1, null],
      ['Graved', NOW - 2 * DAY, 7, 'ssh'],
    ]);
    expect(items[0].title).toBe('Dir');
  });

  it('shows everything with showAll and respects the window edge', () => {
    expect(listRecentlyDeleted(state, NOW, true).map((i) => i.row.rowId)).toEqual(['Dir', 'Graved', 'Old']);
    const edge = listRecentlyDeleted(state, NOW - 40 * DAY + RECENTLY_DELETED_WINDOW_MS, false);
    expect(edge.map((i) => i.row.rowId)).toContain('Old');
  });

  it('shows an empty title and the redacted flag after Delete permanently', () => {
    const erased = deletePermanently(state, [{ tbl: 1, rowId: 'Graved' }]);
    const item = listRecentlyDeleted(erased, NOW, false).find((i) => i.row.rowId === 'Graved');
    expect(item).toMatchObject({ title: '', entryType: null, redacted: true });
  });
});

describe('deletePermanently (4.7)', () => {
  const specs: RowSpec[] = [
    killed(entry('E', { host: 'h', password: Buffer.from('ct') }), T0 + 10, 2),
    history('H1', 'E', { password: Buffer.from('old') }),
    { tbl: 3, id: 'H2', regs: { _life: app(1, T0, 'live'), entry_id: [app(3, T0, 'Other'), app(1, T0, 'E')] } },
    history('H3', 'Other'),
    entry('Other', { host: 'keep' }),
    { tbl: 1, id: 'G', regs: { _life: app(1, T0 + 1, 'dead'), name: [pseudo(0, 5, 'g', 'genesis'), app(4, T0, 'x', { flags: SIB_UNDECRYPTABLE })] } },
  ];
  const state = buildState(specs);

  it('redacts every register except _life and keeps dots, pmem and vv', () => {
    const out = deletePermanently(state, [{ tbl: 1, rowId: 'E' }, { tbl: 1, rowId: 'G' }]);
    for (const reg of ['name', 'entry_type', 'created_at', 'host', 'password']) {
      expect(sibsOf(out, 1, 'E', reg)).toEqual(sibsOf(state, 1, 'E', reg).map(redactedCopy));
    }
    expect(getRegister(out, regKey(1, 'E', '_life'))).toBe(getRegister(state, regKey(1, 'E', '_life')));
    expect(sibsOf(out, 1, 'G', 'name').map((s) => s.flags)).toEqual([SIB_REDACTED, SIB_REDACTED | SIB_UNDECRYPTABLE]);
    expect(getRegister(out, regKey(1, 'G', 'name'))?.pmem).toEqual(getRegister(state, regKey(1, 'G', 'name'))?.pmem);
    expect(out.vv).toBe(state.vv);
    expect(out.rows.get(k(1, 'E'))?.grave).toEqual({ diedMs: T0 + 10, diedC: 0, diedDev: 2, redacted: true });
  });

  it('redacts history rows naming the entry by provisional or any sibling entry_id, and nothing else', () => {
    const out = deletePermanently(state, [{ tbl: 1, rowId: 'E' }]);
    expect(sibsOf(out, 3, 'H1', 'password').every((s) => s.value === null && s.flags === SIB_REDACTED)).toBe(true);
    expect(sibsOf(out, 3, 'H2', 'entry_id').every((s) => s.flags === SIB_REDACTED)).toBe(true);
    expect(out.rows.get(k(3, 'H1'))?.grave).toBeNull();
    expect(out.rows.get(k(3, 'H3'))).toBe(state.rows.get(k(3, 'H3')));
    expect(out.rows.get(k(1, 'Other'))).toBe(state.rows.get(k(1, 'Other')));
  });

  it('marks an existing grave redacted, keeps implicit registers implicit and is idempotent', () => {
    const graved = buildState([{ ...killed(entry('E', {}), T0 + 10, 2), grave: { diedMs: T0 + 10, diedC: 0, diedDev: 2, redacted: false } }]);
    const out = deletePermanently(graved, [{ tbl: 1, rowId: 'E' }]);
    expect(out.rows.get(k(1, 'E'))?.grave?.redacted).toBe(true);
    expect(getRegister(out, regKey(1, 'E', 'notes'))).toBeUndefined();
    expect(deletePermanently(out, [{ tbl: 1, rowId: 'E' }])).toBe(out);
  });

  it('never redacts live or unknown rows', () => {
    const rows = [{ tbl: 1 as const, rowId: 'Other' }, { tbl: 1 as const, rowId: 'Nope' }];
    expect(deletePermanently(state, rows)).toBe(state);
  });

  it('reaches other replicas through merge: redaction wins for every shared identity', () => {
    const erased = deletePermanently(state, [{ tbl: 1, rowId: 'E' }]);
    for (const merged of [merge(erased, state, implicit).state, merge(state, erased, implicit).state]) {
      expect(sibsOf(merged, 1, 'E', 'host')).toEqual(sibsOf(erased, 1, 'E', 'host'));
      expect(merged.rows.get(k(1, 'E'))?.grave?.redacted).toBe(true);
    }
  });
});

describe('emptyRecentlyDeleted', () => {
  it('redacts every dead content row and leaves live rows alone', () => {
    const state = buildState([killed(entry('A', {}), T0 + 1), killed(folder('F', { icon: 'x' }), T0 + 2), entry('L', {})]);
    const out = emptyRecentlyDeleted(state);
    expect(sibsOf(out, 1, 'A', 'name')[0].flags).toBe(SIB_REDACTED);
    expect(sibsOf(out, 2, 'F', 'icon')[0].flags).toBe(SIB_REDACTED);
    expect(out.rows.get(k(1, 'L'))).toBe(state.rows.get(k(1, 'L')));
    expect(emptyRecentlyDeleted(out)).toBe(out);
  });
});

describe('revival after Delete permanently', () => {
  it('materializes redacted-only fields as defaults and reports redacted fields', () => {
    const erased = deletePermanently(buildState([killed(entry('E', { host: 'h' }), T0 + 10)]), [{ tbl: 1, rowId: 'E' }]);
    expect(hasRedactedFields(erased, { tbl: 1, rowId: 'E' })).toBe(false);
    const revived = buildState([{ tbl: 1, id: 'E', regs: { _life: [app(1, T0 + 10, 'dead'), app(9, T0 + 20, 'live')] } }], erased);
    expect(hasRedactedFields(revived, { tbl: 1, rowId: 'E' })).toBe(true);
    const m = materialize(revived, EMPTY_CONTENT, new Map(), { implicit, currentEpoch: null });
    expect(m.plan.upsertEntries[0]).toMatchObject({ name: '', entry_type: 'document', host: null });
    expect(m.state.rows.get(k(1, 'E'))?.grave).toBeNull();
  });

  it('does not report a register that was rewritten after the redaction', () => {
    const erased = deletePermanently(buildState([killed(entry('E', { host: 'h' }), T0 + 10)]), [{ tbl: 1, rowId: 'E' }]);
    const allRewritten: RowSpec = {
      tbl: 1,
      id: 'E',
      regs: Object.fromEntries(
        ['name', 'entry_type', 'created_at', 'host'].map((reg) => [reg, [...sibsOf(erased, 1, 'E', reg), app(9, T0 + 20, 'v')]]),
      ),
    };
    const revived = buildState([{ ...allRewritten, regs: { ...allRewritten.regs, _life: app(9, T0 + 20, 'live') } }], erased);
    expect(hasRedactedFields(revived, { tbl: 1, rowId: 'E' })).toBe(false);
  });
});

describe('restoreWrites (depends on capture-local.prepareWrite)', () => {
  const keys = deriveEpochKeys(Buffer.alloc(32, 7), LINEAGE);
  const ctx: SyncContext = {
    deviceUuid: '00000000-0000-4000-8000-000000000001',
    lineageId: LINEAGE,
    dev: 42,
    incarnation: 'ab'.repeat(16),
    keys: { current: keys, byEpoch: new Map([[keys.epochId, keys]]) },
    now: () => NOW,
    randomBytes: (n) => Buffer.alloc(n, 1),
  };

  it('builds one replace-all live write per dead row, skipping live, unknown and duplicate rows', () => {
    const state = buildState([killed(entry('E', {}), T0 + 1), killed(folder('F', {}), T0 + 1), entry('L', {})]);
    const rows = [
      { tbl: 1 as const, rowId: 'E' },
      { tbl: 1 as const, rowId: 'E' },
      { tbl: 2 as const, rowId: 'F' },
      { tbl: 1 as const, rowId: 'L' },
      { tbl: 1 as const, rowId: 'Nope' },
    ];
    const lifeWrites = restoreWrites(state, rows, ctx).filter((w) => w.key.reg === '_life');
    expect(lifeWrites).toHaveLength(2);
    const lifeE = regKey(1, 'E', '_life');
    expect(lifeWrites[0]).toMatchObject({ key: lifeE, value: 'live', vhash: vhashOfValue(lifeE, 'live'), mode: 'replace-all' });
    expect(lifeWrites[1].key).toEqual(regKey(2, 'F', '_life'));
  });

  it('restores an entry into its restored folder, and to root when the folder stays deleted', () => {
    const state = buildState([killed(folder('F', {}), T0 + 1), killed(entry('E', { container: 'f:F', host: 'h' }), T0 + 1)]);
    const restore = (rows: Array<{ tbl: 1 | 2; rowId: string }>) => {
      const writes = restoreWrites(state, rows, ctx);
      const att = { kind: 'local' as const, dot: { dev: ctx.dev, ms: NOW, c: 0 }, interactive: true };
      const applied = applyLocalWrites(state, writes, att, ctx, implicit).state;
      return materialize(applied, EMPTY_CONTENT, new Map(), { implicit, currentEpoch: null });
    };
    const both = restore([{ tbl: 1, rowId: 'E' }, { tbl: 2, rowId: 'F' }]);
    expect(both.plan.upsertEntries[0]).toMatchObject({ id: 'E', folder_id: 'F', host: 'h' });
    expect(both.plan.upsertFolders.map((r) => r.id)).toEqual(['F']);
    const alone = restore([{ tbl: 1, rowId: 'E' }]);
    expect(alone.plan.upsertEntries[0]).toMatchObject({ id: 'E', folder_id: null });
    expect(alone.plan.upsertFolders).toEqual([]);
    expect(getRegister(alone.state, regKey(1, 'E', 'container'))?.mat).toEqual({ value: 'r' });
  });
});
