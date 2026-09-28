// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CREATE_SCHEMA } from '../../vault/schema.js';
import {
  CONTENT_COLUMNS,
  IMPLICIT_PMEM,
  RAW_HASH_COLUMNS,
  buildConfigText,
  buildContentRow,
  buildTagsText,
  containerTarget,
  deviceRegKey,
  dismissRegKey,
  epochRegKey,
  fixedRegisters,
  implicitSiblingOf,
  isDefaultValue,
  isDocumentContent,
  isEmptyConfigValue,
  normalizeValue,
  ownerRegKey,
  parseContainer,
  readContentRow,
  readEntryRow,
  readFolderRow,
  readHistoryRow,
  readMetaRegisters,
  referencedRows,
  regKey,
  registerDef,
  registerLabel,
  requireDef,
} from '../catalog.js';
import { TBL, ZERO_PID, type EntryRow, type FolderRow, type HistoryRow, type SyncValue } from '../types.js';

const CT = Buffer.from('000102030405060708090a0b0c0d0e0f1011', 'hex');

function entryRow(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'e1',
    name: 'Prod',
    entry_type: 'ssh',
    folder_id: null,
    parent_entry_id: null,
    sort_order: 0,
    host: '10.0.0.1',
    port: 22,
    credential_id: null,
    username: 'root',
    password_encrypted: CT,
    domain: null,
    private_key_encrypted: null,
    totp_secret_encrypted: null,
    icon: null,
    color: null,
    credential_type: null,
    config: '{"b":1,"a":{"y":2,"x":[1,"z"]}}',
    tags: '["prod","db"]',
    is_favorite: 0,
    notes: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

function normalizedValues(values: ReadonlyMap<string, SyncValue>, tbl: 1 | 2 | 3): Map<string, SyncValue> {
  const out = new Map<string, SyncValue>();
  for (const [reg, v] of values) {
    out.set(reg, normalizeValue(requireDef(regKey(tbl, 'x', reg)), v));
  }
  return out;
}

describe('registerDef', () => {
  it('finds fixed registers with class, kind and secret flag', () => {
    const pw = registerDef(regKey(TBL.entries, 'e1', 'password'));
    expect(pw).toMatchObject({ cls: 'prompt', kind: 'secret', secret: true, columns: ['password_encrypted'] });
    expect(registerDef(regKey(TBL.entries, 'e1', 'sort_order'))).toMatchObject({ cls: 'auto', kind: 'int0', defaultValue: 0 });
    expect(registerDef(regKey(TBL.entries, 'e1', 'icon'))?.cls).toBe('groupA');
    expect(registerDef(regKey(TBL.history, 'h1', '_life'))?.cls).toBe('auto');
    expect(registerDef(regKey(TBL.folders, 'f1', 'container'))?.columns).toEqual(['parent_id']);
  });

  it('resolves dynamic families and rejects bare prefixes', () => {
    expect(registerDef(regKey(TBL.entries, 'e1', 'config.hostKey'))).toMatchObject({ family: 'config', kind: 'json', cls: 'prompt' });
    expect(registerDef(regKey(TBL.entries, 'e1', 'tag:prod'))).toMatchObject({ family: 'tag', kind: 'flag', cls: 'groupA' });
    expect(registerDef(regKey(TBL.entries, 'e1', 'config.'))).toBeNull();
    expect(registerDef(regKey(TBL.entries, 'e1', 'tag:'))).toBeNull();
    expect(registerDef(regKey(TBL.folders, 'f1', 'config.x'))).toBeNull();
    expect(registerDef(regKey(TBL.entries, 'e1', 'updated_at'))).toBeNull();
  });

  it('covers vault_meta and _sync registers', () => {
    expect(registerDef(regKey(TBL.meta, 'meta', 'vault_id'))?.cls).toBe('auto');
    expect(registerDef(regKey(TBL.meta, 'meta', 'salt'))).toBeNull();
    expect(registerDef(epochRegKey())).toMatchObject({ cls: 'special', kind: 'text' });
    expect(registerDef(ownerRegKey())).toMatchObject({ cls: 'auto', kind: 'json' });
    expect(registerDef(dismissRegKey('abc'))).toMatchObject({ family: 'dismiss', kind: 'flag' });
    expect(registerDef(deviceRegKey('uuid-1'))).toMatchObject({ family: 'device', kind: 'json' });
    expect(registerDef(regKey(TBL.sync, 'key', 'other'))).toBeNull();
    expect(registerDef(regKey(TBL.sync, 'nope', 'x'))).toBeNull();
    expect(() => requireDef(regKey(TBL.sync, 'nope', 'x'))).toThrow(/unknown register/);
  });

  it('labels dynamic registers', () => {
    expect(registerLabel(regKey(TBL.entries, 'e1', 'config.content'))).toBe('Document');
    expect(registerLabel(regKey(TBL.entries, 'e1', 'config.width'))).toBe('Setting "width"');
    expect(registerLabel(regKey(TBL.entries, 'e1', 'tag:prod'))).toBe('Tag "prod"');
    expect(registerLabel(regKey(TBL.entries, 'e1', 'host'))).toBe('Host');
  });
});

describe('reading content rows', () => {
  it('reads every fixed entry register plus config keys and tags', () => {
    const { values, malformed } = readEntryRow(entryRow());
    expect(malformed).toEqual([]);
    for (const d of fixedRegisters(TBL.entries)) expect(values.has(d.reg)).toBe(true);
    expect(values.get('_life')).toBe('live');
    expect(values.get('container')).toBe('r');
    expect(values.get('config.a')).toBe('{"x":[1,"z"],"y":2}');
    expect(values.get('config.b')).toBe('1');
    expect(values.get('tag:prod')).toBe(1);
    expect(values.get('tag:db')).toBe(1);
    expect(values.get('password')).toEqual(CT);
    expect(values.has('updated_at')).toBe(false);
  });

  it('lets parent_entry_id win over folder_id', () => {
    expect(readEntryRow(entryRow({ folder_id: 'F', parent_entry_id: 'P' })).values.get('container')).toBe('e:P');
    expect(readEntryRow(entryRow({ folder_id: 'F' })).values.get('container')).toBe('f:F');
    expect(readFolderRow(folderRow({ parent_id: 'G' })).values.get('container')).toBe('f:G');
  });

  it('coerces legacy integer text and NULL counters', () => {
    const { values } = readEntryRow(entryRow({ port: '2222', sort_order: null, is_favorite: '1' }));
    expect(values.get('port')).toBe(2222);
    expect(readEntryRow(entryRow({ port: ' ' })).values.get('port')).toBeNull();
    expect(readEntryRow(entryRow({ port: 'abc' })).values.get('port')).toBe('abc');
    expect(values.get('sort_order')).toBe(0);
    expect(values.get('is_favorite')).toBe(1);
  });

  it('reports malformed config and tags without throwing', () => {
    const { values, malformed } = readEntryRow(entryRow({ config: '{nope', tags: '"x"' }));
    expect(malformed).toEqual(['config', 'tags']);
    expect([...values.keys()].some((k) => k.startsWith('config.') || k.startsWith('tag:'))).toBe(false);
  });

  it('reads history rows and dispatches by table', () => {
    const row: HistoryRow = { id: 'h1', entry_id: 'e1', username: 'u', password_encrypted: CT, changed_at: 'x', changed_by: null };
    expect(readHistoryRow(row).values.get('entry_id')).toBe('e1');
    expect(readContentRow(TBL.history, row).values.get('password')).toEqual(CT);
  });

  it('reads synced vault_meta registers only', () => {
    const meta = new Map([
      ['vault_id', 'v-1'],
      ['salt', 's'],
    ]);
    expect([...readMetaRegisters(meta)]).toEqual([
      ['vault_id', 'v-1'],
      ['cloud_sync_enabled', null],
    ]);
  });
});

function folderRow(overrides: Partial<FolderRow> = {}): FolderRow {
  return {
    id: 'f1',
    name: 'Servers',
    parent_id: null,
    sort_order: 3,
    icon: 'server',
    color: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('building content rows', () => {
  it('round-trips an entry through read and build', () => {
    const read = readEntryRow(entryRow({ parent_entry_id: 'P', notes: 'n' })).values;
    const built = buildContentRow(TBL.entries, 'e1', read, 'U') as EntryRow;
    expect(built.parent_entry_id).toBe('P');
    expect(built.folder_id).toBeNull();
    expect(built.config).toBe('{"a":{"x":[1,"z"],"y":2},"b":1}');
    expect(built.tags).toBe('["db","prod"]');
    expect(built.updated_at).toBe('U');
    expect(normalizedValues(readEntryRow(built).values, 1)).toEqual(normalizedValues(read, 1));
  });

  it('fills defaults and NOT NULL fallbacks for missing or redacted values', () => {
    const built = buildContentRow(TBL.entries, 'e2', new Map([['entry_type', null]]), 'U') as EntryRow;
    expect(built).toMatchObject({ name: '', entry_type: 'document', sort_order: 0, is_favorite: 0, config: '{}', tags: '[]' });
    expect(built.created_at).toBe('1970-01-01T00:00:00.000Z');
    const folder = buildContentRow(TBL.folders, 'f2', new Map(), 'U') as FolderRow;
    expect(folder).toMatchObject({ name: '', parent_id: null, sort_order: 0 });
  });

  it('writes absent config keys and tags as nothing', () => {
    const values = new Map<string, SyncValue>([
      ['config.z', '"a"'],
      ['config.gone', null],
      ['tag:b', 1],
      ['tag:a', 1],
      ['tag:gone', null],
    ]);
    expect(buildConfigText(values)).toBe('{"z":"a"}');
    expect(buildTagsText(values)).toBe('["a","b"]');
  });

  it('builds a history row without updated_at', () => {
    const row = buildContentRow(TBL.history, 'h1', new Map<string, SyncValue>([['entry_id', 'e1']]), 'U');
    expect(Object.keys(row).sort()).toEqual([...CONTENT_COLUMNS[3]].sort());
  });
});

describe('defaults, containers and rule helpers', () => {
  it('treats empty optional text, NULL counters and empty secrets as default', () => {
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'host')), '')).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'name')), '')).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'sort_order')), null)).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'password')), new Uint8Array())).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'container')), 'r')).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', '_life')), 'live')).toBe(true);
    expect(isDefaultValue(requireDef(regKey(1, 'e', '_life')), 'dead')).toBe(false);
    expect(isDefaultValue(requireDef(regKey(1, 'e', 'config.k')), 'null')).toBe(false);
  });

  it('parses containers and their targets', () => {
    expect(parseContainer('r')).toEqual({ kind: 'r' });
    expect(parseContainer('f:abc')).toEqual({ kind: 'f', id: 'abc' });
    expect(parseContainer('x:abc')).toBeNull();
    expect(parseContainer('f:')).toBeNull();
    expect(containerTarget('e:E')).toEqual({ tbl: TBL.entries, rowId: 'E' });
    expect(containerTarget('f:F')).toEqual({ tbl: TBL.folders, rowId: 'F' });
    expect(containerTarget('r')).toBeNull();
  });

  it('lists referenced rows for rule R', () => {
    expect(referencedRows(TBL.entries, new Map([['credential_id', 'C']]))).toEqual([{ tbl: 1, rowId: 'C' }]);
    expect(referencedRows(TBL.history, new Map([['entry_id', 'E']]))).toEqual([{ tbl: 1, rowId: 'E' }]);
    expect(referencedRows(TBL.folders, new Map())).toEqual([]);
  });

  it('recognizes empty config values and document content', () => {
    expect(['[]', '{}', '""', null].every(isEmptyConfigValue)).toBe(true);
    expect(isEmptyConfigValue('0')).toBe(false);
    expect(isDocumentContent(regKey(1, 'e', 'config.content'), 'document')).toBe(true);
    expect(isDocumentContent(regKey(1, 'e', 'config.content'), 'ssh')).toBe(false);
  });

  it('builds the implicit genesis sibling', () => {
    const s = implicitSiblingOf(regKey(1, 'e', 'sort_order'), 'ab'.repeat(16));
    expect(s).toMatchObject({ dev: 0, ms: 0, c: 0, pid: ZERO_PID, lt: 0, value: 0, flags: 0 });
    expect(IMPLICIT_PMEM).toEqual({ ms: 0, ids: [ZERO_PID] });
  });

  it('excludes id and updated_at from raw_hash columns', () => {
    for (const cols of Object.values(RAW_HASH_COLUMNS)) {
      expect(cols).not.toContain('id');
      expect(cols).not.toContain('updated_at');
    }
    expect(RAW_HASH_COLUMNS[1]).toHaveLength(CONTENT_COLUMNS[1].length - 2);
  });
});

describe('catalog against a real vault database', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-catalog-'));
    db = new Database(path.join(dir, 'v.conduit'));
    db.exec(CREATE_SCHEMA);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a built row and reads the same registers back', () => {
    const source = readEntryRow(entryRow({ folder_id: null, parent_entry_id: null, port: 2222 })).values;
    const built = buildContentRow(TBL.entries, 'e1', source, '2026-09-03T00:00:00.000Z') as EntryRow;
    const cols = CONTENT_COLUMNS[1];
    db.prepare(`INSERT INTO entries (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(built);
    const stored = db.prepare('SELECT * FROM entries WHERE id = ?').get('e1') as EntryRow;
    expect(Buffer.isBuffer(stored.password_encrypted)).toBe(true);
    expect(normalizedValues(readEntryRow(stored).values, 1)).toEqual(normalizedValues(source, 1));
  });
});
