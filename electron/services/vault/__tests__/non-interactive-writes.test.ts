// @vitest-environment node
// Importers and the autofill-selector save write through runNonInteractive (spec 4.2 step 5):
// the capture hook sees interactive = false, so an open sync conflict stays open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../vault.js';
import { exportVault, importIntoVault } from '../export-import.js';
import { executeImport } from '../../import/rdm-importer.js';
import type { ImportPreviewEntry } from '../../import/types.js';
import { saveAutofillSelectors } from '../../../ipc/web-autofill.js';
import type { VaultMutationInfo, VaultSyncHooks } from '../../sync/host.js';

class RecordingHooks implements VaultSyncHooks {
  readonly captures: VaultMutationInfo[] = [];
  captureInTransaction(info: VaultMutationInfo): void {
    this.captures.push(info);
  }
  afterCommit(): void {}
  requestFullPass(): void {}
  interactiveFlags(): boolean[] {
    return this.captures.map((c) => c.interactive);
  }
}

let dir: string;
let vault: ConduitVault;
let hooks: RecordingHooks;

function openVault(name: string): ConduitVault {
  const v = new ConduitVault(path.join(dir, name));
  v.initialize('pw');
  return v;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-non-interactive-'));
  vault = openVault('v.conduit');
  hooks = new RecordingHooks();
  vault.setSyncHooks(hooks);
});

afterEach(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rdmEntry(name: string): ImportPreviewEntry {
  return {
    rdmId: name,
    name,
    conduitType: 'ssh',
    status: 'ready',
    statusMessage: null,
    folderPath: 'Imported',
    host: 'example.test',
    port: 22,
    username: 'root',
    password: 'secret',
    domain: null,
    notes: null,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

describe('non-interactive writes', () => {
  it('a direct edit is interactive (control)', () => {
    vault.createFolder({ name: 'F' });
    expect(hooks.interactiveFlags()).toEqual([true]);
  });

  it('RDM import', () => {
    const result = executeImport(vault, [rdmEntry('a'), rdmEntry('b')], { maxEntries: -1, existingEntryCount: 0 });
    expect(result.imported).toBe(2);
    expect(hooks.captures.length).toBeGreaterThan(0);
    expect(hooks.interactiveFlags().every((f) => f === false)).toBe(true);
  });

  it('.conduit-export import', () => {
    const source = openVault('source.conduit');
    const folder = source.createFolder({ name: 'Servers' });
    source.createEntry({ name: 'web', entry_type: 'ssh', host: 'h', folder_id: folder.id });
    const exportPath = path.join(dir, 'x.conduit-export');
    exportVault(source, { scope: 'full', passphrase: 'correct horse battery', outputPath: exportPath });
    source.lock();
    importIntoVault(vault, exportPath, 'correct horse battery');
    expect(hooks.captures.length).toBeGreaterThan(0);
    expect(hooks.interactiveFlags().every((f) => f === false)).toBe(true);
  });

  it('autofill selector save merges the config and is not interactive', () => {
    const entry = vault.createEntry({ name: 'site', entry_type: 'web', host: 'https://example.test', config: { autofill: { loginUrlPattern: '/login' } } });
    hooks.captures.length = 0;
    const saved = saveAutofillSelectors(vault, entry.id, { usernameSelector: '#u', passwordSelector: 42 });
    expect(saved).toEqual({ loginUrlPattern: '/login', enabled: true, usernameSelector: '#u' });
    expect(vault.getEntryMeta(entry.id).config).toEqual({ autofill: saved });
    expect(hooks.interactiveFlags()).toEqual([false]);
    expect(() => saveAutofillSelectors(vault, 42, {})).toThrow('Invalid entry id');
  });

  it('the next direct edit is interactive again', () => {
    executeImport(vault, [rdmEntry('a')], { maxEntries: -1, existingEntryCount: 0 });
    hooks.captures.length = 0;
    vault.createFolder({ name: 'After' });
    expect(hooks.interactiveFlags()).toEqual([true]);
  });
});
