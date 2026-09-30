// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { detectDuplicates, executeImport } from '../rdm-importer.js';
import type { ImportPreviewEntry } from '../types.js';

let dir: string;
let vault: ConduitVault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-rdm-history-'));
  vault = new ConduitVault(path.join(dir, 'v.conduit'));
  vault.initialize('pw');
});

afterEach(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

function preview(overrides: Partial<ImportPreviewEntry>): ImportPreviewEntry {
  return {
    rdmId: 'r1',
    name: 'web-01',
    conduitType: 'ssh',
    status: 'ready',
    statusMessage: null,
    folderPath: null,
    host: 'web01.example.test',
    port: 22,
    username: 'root',
    password: 'new-secret',
    domain: null,
    notes: null,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
    ...overrides,
  };
}

function overwrite(entries: ImportPreviewEntry[]) {
  detectDuplicates(entries, vault);
  return executeImport(vault, entries, {
    maxEntries: -1,
    existingEntryCount: vault.listEntries().length,
    duplicateStrategy: 'overwrite',
    changedBy: 'owner@example.test',
  });
}

describe('RDM import overwrite and password history', () => {
  it('records the old password of a connection entry before overwriting it', () => {
    const existing = vault.createEntry({
      name: 'web-01', entry_type: 'ssh', host: 'web01.example.test', username: 'root', password: 'old-secret',
    });

    const result = overwrite([preview({})]);

    expect(result.entries[0].status).toBe('overwritten');
    expect(vault.getEntry(existing.id).password).toBe('new-secret');
    const history = vault.listPasswordHistory(existing.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ username: 'root', password: 'old-secret', changed_by: 'owner@example.test' });
    const age = vault.listPasswordAges().find((a) => a.entryId === existing.id);
    expect(age).toEqual({ entryId: existing.id, setAt: history[0].changed_at, source: 'history' });
  });

  it('records the old password of a group credential before overwriting it', () => {
    const existing = vault.createEntry({
      name: 'Domain Admin', entry_type: 'credential', username: 'admin', password: 'old-secret',
    });

    overwrite([preview({ rdmId: 'c1', name: 'Domain Admin', conduitType: 'credential', host: null, port: null, username: 'admin', isGroupCredential: true })]);

    expect(vault.listPasswordHistory(existing.id)).toMatchObject([{ username: 'admin', password: 'old-secret' }]);
  });

  it('records no history when the overwrite keeps the same username and password', () => {
    const existing = vault.createEntry({
      name: 'web-01', entry_type: 'ssh', host: 'web01.example.test', username: 'root', password: 'new-secret',
    });

    overwrite([preview({})]);

    expect(vault.listPasswordHistory(existing.id)).toEqual([]);
    expect(vault.listPasswordAges().find((a) => a.entryId === existing.id)?.source).toBe('created');
  });
});
