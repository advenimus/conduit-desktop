// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATE_SCHEMA } from '../../vault/schema.js';
import { buildContentRow, rowKey } from '../catalog.js';
import { applyWritePlan, loadContent, loadContentRows, loadFile, saveState } from '../state-store.js';
import { emptyState } from '../state-view.js';
import { TBL, type EntryRow, type FolderRow, type HistoryRow, type WritePlan } from '../types.js';
import { UPDATED_AT, bytes, countRows, openVault, type TempVault } from './state-store-fixtures.js';

const vaults: TempVault[] = [];
function vault(opts?: Parameters<typeof openVault>[0]): TempVault {
  const v = openVault(opts);
  vaults.push(v);
  return v;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const v of vaults.splice(0)) v.close();
});

const folder = (id: string, parent: string | null): FolderRow =>
  buildContentRow(TBL.folders, id, new Map([['name', id], ['container', parent ? `f:${parent}` : 'r']]), UPDATED_AT) as FolderRow;

const entry = (id: string, container: string, extra: Record<string, string | number | Buffer> = {}): EntryRow =>
  buildContentRow(
    TBL.entries,
    id,
    new Map<string, string | number | Buffer>([['name', id], ['entry_type', 'ssh'], ['container', container], ...Object.entries(extra)]),
    UPDATED_AT,
  ) as EntryRow;

const history = (id: string, entryId: string): HistoryRow =>
  buildContentRow(
    TBL.history,
    id,
    new Map<string, string | Buffer>([['entry_id', entryId], ['password', bytes(id)], ['changed_at', UPDATED_AT]]),
    UPDATED_AT,
  ) as HistoryRow;

const EMPTY_PLAN: WritePlan = {
  upsertFolders: [],
  upsertEntries: [],
  upsertHistory: [],
  deleteHistory: [],
  deleteEntries: [],
  deleteFolders: [],
  meta: new Map(),
};

const planOf = (p: Partial<WritePlan>): WritePlan => ({ ...EMPTY_PLAN, ...p });

function runPlan(v: TempVault, plan: WritePlan): void {
  saveState(v.db, { state: emptyState('L', 'G', 0), plan, cache: new Map(), baseline: null });
}

function seed(v: TempVault): void {
  runPlan(
    v,
    planOf({
      upsertFolders: [folder('F', null)],
      upsertEntries: [entry('A', 'f:F'), entry('B', 'e:A')],
      upsertHistory: [history('H', 'A')],
    }),
  );
}

describe('applyWritePlan (4.6 step 5)', () => {
  it('applies moves, upserts and deletes in FK-safe order without cascading into live rows', () => {
    const v = vault();
    seed(v);
    runPlan(
      v,
      planOf({
        // G's parent P comes later in the same list: deferred foreign keys allow it.
        upsertFolders: [folder('G', 'P'), folder('P', null)],
        upsertEntries: [entry('A', 'f:G', { host: 'renamed' }), entry('B', 'r')],
        deleteFolders: ['F'],
        meta: new Map([['vault_id', 'v-1'], ['salt', null]]),
      }),
    );
    const content = loadContent(v.db);
    expect(content.folders.has('F')).toBe(false);
    expect(content.entries.get('A')).toMatchObject({ folder_id: 'G', host: 'renamed' });
    expect(content.entries.get('B')).toMatchObject({ folder_id: null, parent_entry_id: null });
    // An upsert must not delete and re-insert A, which would cascade to its history.
    expect(content.history.has('H')).toBe(true);
    expect(content.meta.get('vault_id')).toBe('v-1');
    expect(content.meta.has('salt')).toBe(false);
    expect(v.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back content and sync tables when a foreign key would dangle', () => {
    const v = vault();
    seed(v);
    const entriesBefore = loadContent(v.db).entries;
    const bad = planOf({ upsertEntries: [entry('C', 'f:missing')], deleteHistory: ['H'] });
    expect(() => runPlan(v, bad)).toThrow(/FOREIGN KEY/);
    const after = loadContent(v.db);
    expect(after.entries).toEqual(entriesBefore);
    expect(after.history.has('H')).toBe(true);
    expect(loadFile(v.db).state.lineageId).toBe('L');
  });

  it('keeps integer, text and blob storage classes in content columns', () => {
    const v = vault();
    runPlan(v, planOf({ upsertEntries: [entry('A', 'r', { port: 22, sort_order: 3, password: bytes('pw') })] }));
    const row = v.db
      .prepare("SELECT typeof(port) AS p, typeof(sort_order) AS s, typeof(password_encrypted) AS pw, typeof(name) AS n FROM entries WHERE id = 'A'")
      .get();
    expect(row).toEqual({ p: 'integer', s: 'integer', pw: 'blob', n: 'text' });
  });

  it('runs inside a caller transaction', () => {
    const v = vault();
    v.db.transaction(() => applyWritePlan(v.db, planOf({ upsertFolders: [folder('X', null)] })))();
    expect(countRows(v.db, 'folders')).toBe(1);
  });
});

const V9_SCHEMA = CREATE_SCHEMA.replace(
  /\s*parent_entry_id TEXT REFERENCES entries\(id\) ON DELETE SET NULL,/,
  '',
).replace(/\s*CREATE INDEX IF NOT EXISTS idx_entries_parent_entry[^;]*;/, '');

describe('loadContent', () => {
  it('reads older schemas: missing columns are NULL, missing password_history is empty', () => {
    expect(V9_SCHEMA).not.toContain('parent_entry_id');
    const v = vault({ sync: false, schema: V9_SCHEMA });
    v.db.prepare("INSERT INTO entries (id, name, entry_type, folder_id, created_at, updated_at) VALUES ('a', 'A', 'ssh', NULL, 'x', 'y')").run();
    const content = loadContent(v.db);
    expect(content.entries.get('a')).toMatchObject({ id: 'a', name: 'A', parent_entry_id: null, config: '{}' });
    expect(content.history.size).toBe(0);
    expect(content.meta.get('schema_version')).toBe('10');
  });

  it('skips rows without a usable id and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const v = vault();
    v.db.prepare("INSERT INTO folders (id, name, created_at, updated_at) VALUES (NULL, 'n', 'x', 'y')").run();
    v.db.prepare("INSERT INTO folders (id, name, created_at, updated_at) VALUES ('', 'e', 'x', 'y')").run();
    v.db.prepare("INSERT INTO folders (id, name, created_at, updated_at) VALUES ('ok', 'o', 'x', 'y')").run();
    expect([...loadContent(v.db).folders.keys()]).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that is not a vault', () => {
    const v = vault({ sync: false });
    v.db.exec('DROP TABLE entries');
    expect(() => loadContent(v.db)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }));
  });
});

describe('loadContentRows', () => {
  it('reads only the listed rows plus every vault_meta key', () => {
    const v = vault();
    seed(v);
    const snap = loadContentRows(v.db, [rowKey(TBL.entries, 'B'), rowKey(TBL.entries, 'nope'), rowKey(TBL.meta, 'meta')]);
    expect([...snap.entries.keys()]).toEqual(['B']);
    expect(snap.folders.size).toBe(0);
    expect(snap.history.size).toBe(0);
    expect(snap.meta.get('sync_format')).toBe('1');
    const both = loadContentRows(v.db, [rowKey(TBL.history, 'H'), rowKey(TBL.folders, 'F')]);
    expect([...both.history.keys()]).toEqual(['H']);
    expect([...both.folders.keys()]).toEqual(['F']);
  });
});
