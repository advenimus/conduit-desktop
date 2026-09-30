// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { rawHash } from '../hashing.js';
import { materialize, type MaterializeContext } from '../materialize.js';
import { applyWritePlan, loadContent } from '../state-store.js';
import { rowKeyStr } from '../state-view.js';
import { SIB_REDACTED, type ContentSnapshot, type ContentTbl, type EpochRecord, type MaterializeResult, type RowCache } from '../types.js';
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
  insertRows,
  killed,
  openTempVault,
  snapshot,
  type RowSpec,
  type TempVault,
} from './materialize-fixtures.js';

const EPOCH: EpochRecord = { epochId: 'e'.repeat(32), parent: null, salt: 'S1', verification: 'V1', createdMs: 0 };
const MCTX: MaterializeContext = { implicit, currentEpoch: EPOCH };
const PERF_BUDGET_MS = 300;
const PERF_SLACK = 3;
const PERF_ENTRIES = 5000;
const PERF_FOLDERS = 100;

let vault: TempVault | null = null;
afterEach(() => {
  vault?.close();
  vault = null;
});

function apply(v: TempVault, m: MaterializeResult): void {
  v.db.transaction(() => applyWritePlan(v.db, m.plan))();
}

function expectCacheMatchesDisk(m: MaterializeResult, content: ContentSnapshot): void {
  const tables: Array<[ContentTbl, ReadonlyMap<string, object>]> = [[1, content.entries], [2, content.folders], [3, content.history]];
  for (const [tbl, rows] of tables) {
    for (const [id, row] of rows) {
      const entryOf = m.cache.get(rowKeyStr({ tbl, rowId: id }));
      expect(entryOf, `${tbl}:${id}`).toEqual({ materialized: true, rawHash: rawHash(tbl, row as never) });
    }
  }
}

function fkFixture(v: TempVault): void {
  insertRows(v.db, 'folders', [folderRow('F1'), folderRow('F2', { parent_id: 'F1' })]);
  insertRows(v.db, 'entries', [
    entryRow('C', { entry_type: 'credential' }),
    entryRow('P'),
    entryRow('P2'),
    entryRow('E1', { folder_id: 'F1' }),
    entryRow('E2', { folder_id: 'F2' }),
    entryRow('E3', { credential_id: 'C' }),
    entryRow('K', { parent_entry_id: 'P' }),
    entryRow('B', { folder_id: 'F1', parent_entry_id: 'P2' }),
  ]);
  insertRows(v.db, 'password_history', [historyRow('H1', 'E1'), historyRow('H2', 'C')]);
  insertRows(v.db, 'vault_meta', [
    { key: 'salt', value: 'S0' },
    { key: 'verification', value: 'V0' },
  ]);
}

const FK_STATE: RowSpec[] = [
  killed(folder('F1', {}), T0 + 1),
  folder('F2', { container: 'f:F1' }),
  killed(entry('C', { entry_type: 'credential' }), T0 + 1),
  killed(entry('P', {}), T0 + 1),
  entry('P2', {}),
  entry('E1', { container: 'f:F1' }),
  entry('E2', { container: 'f:F2' }),
  entry('E3', { credential_id: 'C' }),
  entry('K', { container: 'e:P' }),
  entry('B', { container: 'e:P2' }),
  history('H1', 'E1'),
  history('H2', 'C'),
  { tbl: 4, id: 'meta', regs: { vault_id: app(1, T0, 'vid') } },
];

describe('write plan against SQLite with foreign_keys ON', () => {
  it('applies FK-safely: fallbacks, no cascades onto live rows, deterministic cache', () => {
    vault = openTempVault();
    fkFixture(vault);
    const before = loadContent(vault.db);
    const m = materialize(buildState(FK_STATE), before, new Map(), MCTX);
    expect(m.plan.deleteHistory).toEqual(['H2']);
    expect(m.plan.deleteEntries).toEqual(['C', 'P']);
    expect(m.plan.deleteFolders).toEqual(['F1']);
    apply(vault, m);

    expect(vault.db.pragma('foreign_key_check')).toEqual([]);
    const after = loadContent(vault.db);
    expect([...after.folders.values()].map((r) => [r.id, r.parent_id])).toEqual([['F2', null]]);
    const entries = Object.fromEntries([...after.entries.values()].map((r) => [r.id, [r.folder_id, r.parent_entry_id, r.credential_id]]));
    expect(entries).toEqual({
      P2: [null, null, null],
      E1: [null, null, null],
      E2: ['F2', null, null],
      E3: [null, null, null],
      K: [null, null, null],
      B: [null, 'P2', null],
    });
    expect([...after.history.keys()]).toEqual(['H1']);
    expect(Object.fromEntries(after.meta)).toMatchObject({ salt: 'S1', verification: 'V1', key_source: 'password', vault_id: 'vid' });
    expectCacheMatchesDisk(m, after);

    const again = materialize(m.state, after, m.cache, MCTX);
    expect(again.changedRows).toEqual([]);
    expect(again.plan.meta.size).toBe(0);
    expect(again.state).toBe(m.state);
    expect(again.cache).toBe(m.cache);
  });

  it('writes NOT NULL and CHECK-safe fallbacks for a revived redacted entry', () => {
    vault = openTempVault();
    const red = app(1, T0, null, { flags: SIB_REDACTED });
    const state = buildState([{ tbl: 1, id: 'R', regs: { _life: app(2, T0 + 5, 'live'), name: red, entry_type: red, created_at: red } }]);
    const m = materialize(state, loadContent(vault.db), new Map(), MCTX);
    apply(vault, m);
    const row = loadContent(vault.db).entries.get('R');
    expect(row).toMatchObject({ name: '', entry_type: 'document', created_at: '1970-01-01T00:00:00.000Z' });
  });

  it('round-trips a history row through its entry dying and reviving', () => {
    vault = openTempVault();
    const liveSpecs = [entry('E', {}), history('H', 'E', { username: 'u', password: Buffer.from([1, 2, 3]) })];
    const first = materialize(buildState(liveSpecs), EMPTY_CONTENT, new Map(), MCTX);
    apply(vault, first);
    const deadState = buildState([killed(entry('E', {}), T0 + 1)], first.state);
    const second = materialize(deadState, loadContent(vault.db), first.cache, MCTX);
    apply(vault, second);
    expect(loadContent(vault.db).history.size).toBe(0);
    const revived = buildState([{ tbl: 1, id: 'E', regs: { _life: [app(1, T0 + 1, 'dead'), app(2, T0 + 2, 'live')] } }], second.state);
    const third = materialize(revived, loadContent(vault.db), second.cache, MCTX);
    apply(vault, third);
    const h = loadContent(vault.db).history.get('H');
    expect(h?.username).toBe('u');
    expect(Buffer.from(h?.password_encrypted as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(vault.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps canonically equal legacy rows byte-for-byte (GRDB created_at, empty host)', () => {
    vault = openTempVault();
    insertRows(vault.db, 'entries', [entryRow('E', { created_at: '2025-12-01 00:00:00', host: '', config: '{"b": 2, "a": 1}', updated_at: 'legacy' })]);
    const state = buildState([entry('E', { created_at: CREATED, 'config.a': '1', 'config.b': '2' })]);
    const m = materialize(state, loadContent(vault.db), new Map(), MCTX);
    expect(m.plan.upsertEntries).toEqual([]);
    expect(m.state).toBe(state);
  });
});

function perfState(): RowSpec[] {
  const specs: RowSpec[] = [];
  for (let f = 0; f < PERF_FOLDERS; f++) specs.push(folder(`f${f}`, { container: f > 0 ? `f:f${f - 1}` : 'r' }));
  for (let i = 0; i < PERF_ENTRIES; i++) {
    specs.push(
      entry(`e${i}`, {
        container: `f:f${i % PERF_FOLDERS}`,
        host: `host-${i}.example`,
        port: 22,
        username: `user${i}`,
        password: Buffer.alloc(40, i % 256),
        notes: `notes ${i}`,
        icon: 'server',
        'config.shell': '"bash"',
        'config.keepalive': '30',
        'tag:prod': 1,
      }),
    );
  }
  return specs;
}

describe('performance (spec 13.3)', () => {
  it(`materializes ${PERF_ENTRIES} entries well inside the merge + materialize budget`, () => {
    const state = buildState(perfState());
    let t = performance.now();
    const first = materialize(state, EMPTY_CONTENT, new Map(), MCTX);
    const insertMs = performance.now() - t;
    const content = snapshot({ entries: [...first.plan.upsertEntries], folders: [...first.plan.upsertFolders] });
    t = performance.now();
    const second = materialize(first.state, content, first.cache as RowCache, MCTX);
    const steadyMs = performance.now() - t;
    expect(first.plan.upsertEntries).toHaveLength(PERF_ENTRIES);
    expect(second.changedRows).toEqual([]);
    console.info(`[perf] materialize ${PERF_ENTRIES} entries: insert ${insertMs.toFixed(1)} ms, steady ${steadyMs.toFixed(1)} ms`);
    expect(insertMs).toBeLessThan(PERF_BUDGET_MS * PERF_SLACK);
    expect(steadyMs).toBeLessThan(PERF_BUDGET_MS * PERF_SLACK);
  });
});
