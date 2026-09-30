// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionHistoryStore, HISTORY_SCHEMA_VERSION, PRUNE_EVERY_INSERTS } from '../connection-history-store.js';
import { HISTORY_MAX_ROWS_PER_VAULT, HISTORY_RETENTION_DAYS } from '../dashboard-dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-29T12:00:00.000Z');

let dir: string;
let file: string;
let nowMs: number;
let seq: number;
let stores: ConnectionHistoryStore[];

function open(): ConnectionHistoryStore {
  const store = ConnectionHistoryStore.open(file, { now: () => new Date(nowMs), newId: () => `row-${++seq}` });
  stores.push(store);
  return store;
}

function rawRows(): Array<Record<string, unknown>> {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT * FROM connection_history ORDER BY rowid').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-history-'));
  file = path.join(dir, 'nested', 'connection-history.db');
  nowMs = T0;
  seq = 0;
  stores = [];
});

afterEach(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConnectionHistoryStore schema', () => {
  it('creates the file, the table, both indexes and user_version 1', () => {
    open().close();
    const db = new Database(file, { readonly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['connection_history', 'idx_history_vault_started', 'idx_history_vault_entry']));
    const columns = (db.prepare('PRAGMA table_info(connection_history)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(['id', 'vault_key', 'entry_id', 'protocol', 'started_at', 'ended_at', 'duration_ms', 'outcome']);
    expect(db.pragma('user_version', { simple: true })).toBe(HISTORY_SCHEMA_VERSION);
    db.close();
  });

  it('rejects a protocol or outcome outside the lists', () => {
    const store = open();
    expect(() => store.start('vault:a', 'e1', 'telnet' as never)).toThrow();
  });
});

describe('start and end', () => {
  it('starts an open row and ends it with the time, duration and outcome', () => {
    const store = open();
    const id = store.start('vault:a', 'e1', 'ssh');
    expect(rawRows()[0]).toMatchObject({ id, vault_key: 'vault:a', entry_id: 'e1', protocol: 'ssh', outcome: 'open', ended_at: null, duration_ms: null });
    nowMs += 65_000;
    store.end(id, 'dropped');
    expect(rawRows()[0]).toMatchObject({ outcome: 'dropped', ended_at: new Date(T0 + 65_000).toISOString(), duration_ms: 65_000 });
  });

  it('changes only rows that are still open and ignores unknown ids', () => {
    const store = open();
    const id = store.start('vault:a', 'e1', 'rdp');
    store.end(id, 'failed');
    nowMs += 1000;
    store.end(id, 'closed');
    store.end('no-such-row', 'closed');
    expect(rawRows()).toHaveLength(1);
    expect(rawRows()[0]).toMatchObject({ outcome: 'failed', duration_ms: 0 });
  });

  it('stores no host, name or error text', () => {
    const store = open();
    store.start('vault:a', 'e1', 'web');
    expect(Object.keys(rawRows()[0]).sort()).toEqual(['duration_ms', 'ended_at', 'entry_id', 'id', 'outcome', 'protocol', 'started_at', 'vault_key']);
  });
});

describe('recent and forEntry', () => {
  it('gives one row per entry with its latest event and count, newest first, per vault key', () => {
    const store = open();
    const a1 = store.start('vault:a', 'e1', 'ssh');
    store.end(a1, 'closed');
    nowMs += 1000;
    store.start('vault:a', 'e2', 'web');
    nowMs += 1000;
    const a3 = store.start('vault:a', 'e1', 'ssh');
    store.end(a3, 'failed');
    nowMs += 1000;
    store.start('vault:b', 'e9', 'vnc');

    const recent = store.recent('vault:a', 8);
    expect(recent).toEqual([
      { entryId: 'e1', protocol: 'ssh', lastStartedAt: new Date(T0 + 2000).toISOString(), lastEndedAt: new Date(T0 + 2000).toISOString(), lastDurationMs: 0, lastOutcome: 'failed', count: 2 },
      { entryId: 'e2', protocol: 'web', lastStartedAt: new Date(T0 + 1000).toISOString(), lastEndedAt: null, lastDurationMs: null, lastOutcome: 'open', count: 1 },
    ]);
    expect(store.recent('vault:a', 1)).toHaveLength(1);
    expect(store.recent('vault:b', 8).map((r) => r.entryId)).toEqual(['e9']);
  });

  it('keeps one row per entry when two events share a start time', () => {
    const store = open();
    store.start('vault:a', 'e1', 'ssh');
    const second = store.start('vault:a', 'e1', 'ssh');
    store.end(second, 'closed');
    expect(store.recent('vault:a', 8)).toEqual([expect.objectContaining({ entryId: 'e1', lastOutcome: 'closed', count: 2 })]);
  });

  it('lists one entry newest first with a limit', () => {
    const store = open();
    for (let i = 0; i < 3; i += 1) {
      store.start('vault:a', 'e1', 'command');
      nowMs += 1000;
    }
    store.start('vault:a', 'e2', 'command');
    const events = store.forEntry('vault:a', 'e1', 2);
    expect(events.map((e) => e.id)).toEqual(['row-3', 'row-2']);
    expect(events[0]).toEqual({ id: 'row-3', entryId: 'e1', protocol: 'command', startedAt: new Date(T0 + 2000).toISOString(), endedAt: null, durationMs: null, outcome: 'open' });
    expect(store.forEntry('vault:b', 'e1', 20)).toEqual([]);
  });

  it('clears only the given vault key', () => {
    const store = open();
    store.start('vault:a', 'e1', 'ssh');
    store.start('vault:a', 'e2', 'ssh');
    store.start('team:t', 'e1', 'ssh');
    expect(store.clear('vault:a')).toBe(2);
    expect(store.clear('vault:a')).toBe(0);
    expect(store.recent('team:t', 8)).toHaveLength(1);
  });
});

describe('retention', () => {
  it('drops rows older than the retention window at open', () => {
    const store = open();
    store.start('vault:a', 'old', 'ssh');
    nowMs += HISTORY_RETENTION_DAYS * DAY_MS + 1000;
    store.start('vault:a', 'new', 'ssh');
    expect(store.recent('vault:a', 50).map((r) => r.entryId)).toEqual(['new']);
    store.close();
    open();
    expect(rawRows().map((r) => r.entry_id)).toEqual(['new']);
  });

  it('keeps the newest rows of each vault key after the row cap', () => {
    const store = open();
    const db = new Database(file);
    const insert = db.prepare(
      "INSERT INTO connection_history (id, vault_key, entry_id, protocol, started_at, outcome) VALUES (?, ?, 'e', 'ssh', ?, 'closed')",
    );
    db.transaction(() => {
      for (let i = 0; i < HISTORY_MAX_ROWS_PER_VAULT + 3; i += 1) insert.run(`a-${i}`, 'vault:a', new Date(T0 - (i + 1) * 1000).toISOString());
      insert.run('b-0', 'vault:b', new Date(T0 - 1000).toISOString());
    })();
    db.close();
    store.prune();
    const rows = rawRows();
    expect(rows.filter((r) => r.vault_key === 'vault:a')).toHaveLength(HISTORY_MAX_ROWS_PER_VAULT);
    expect(rows.some((r) => r.id === `a-${HISTORY_MAX_ROWS_PER_VAULT + 2}`)).toBe(false);
    expect(rows.some((r) => r.id === 'a-0')).toBe(true);
    expect(rows.some((r) => r.id === 'b-0')).toBe(true);
  });

  it('prunes again after every 50th insert', () => {
    const store = open();
    store.start('vault:a', 'old', 'ssh');
    nowMs += HISTORY_RETENTION_DAYS * DAY_MS + 1000;
    for (let i = 1; i < PRUNE_EVERY_INSERTS - 1; i += 1) store.start('vault:a', `e${i}`, 'ssh');
    expect(rawRows().some((r) => r.entry_id === 'old')).toBe(true);
    store.start('vault:a', 'last', 'ssh');
    expect(rawRows().some((r) => r.entry_id === 'old')).toBe(false);
  });
});

describe('crash and quit', () => {
  it('marks rows left open by a previous process as interrupted when the store opens', () => {
    const store = open();
    const id = store.start('vault:a', 'e1', 'ssh');
    store.close();
    open();
    expect(rawRows()[0]).toMatchObject({ id, outcome: 'interrupted', ended_at: null, duration_ms: null });
  });

  it('closes every open row at quit with its duration', () => {
    const store = open();
    const a = store.start('vault:a', 'e1', 'ssh');
    const b = store.start('team:t', 'e2', 'rdp');
    store.end(b, 'failed');
    nowMs += 5000;
    expect(store.closeOpenRows()).toBe(1);
    const rows = rawRows();
    expect(rows.find((r) => r.id === a)).toMatchObject({ outcome: 'closed', duration_ms: 5000, ended_at: new Date(T0 + 5000).toISOString() });
    expect(rows.find((r) => r.id === b)).toMatchObject({ outcome: 'failed' });
  });
});
