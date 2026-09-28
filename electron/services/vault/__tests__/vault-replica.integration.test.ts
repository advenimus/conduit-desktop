// @vitest-environment node
// ConduitVault as the real working-copy host of a real replica: edits made through the vault
// API are captured in the same transaction, and a capture the replica refuses rolls back.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault } from '../vault.js';
import { createVaultWorkingCopyHost } from '../../sync/host-electron-vault.js';
import { createNodeTimers } from '../../sync/host-node.js';
import { rowLife } from '../../sync/state-view.js';
import type { ReplicaPort } from '../../sync/replica.js';
import type { VaultMutationInfo } from '../../sync/host.js';
import { TBL } from '../../sync/types.js';
import { MemoryLogger, makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { makeDevice, newVaultSeed, open, provisionalOf } from '../../sync/__tests__/replica-fixtures.js';

let root: string;
let vault: ConduitVault;
let replica: ReplicaPort | null;
let refreshes: number;

beforeEach(async () => {
  root = makeTempRoot('vault-replica');
  vault = new ConduitVault(path.join(root, 'Shared.conduit'));
  refreshes = 0;
  const workingCopy = createVaultWorkingCopyHost({
    vault: () => vault,
    refreshRenderer: () => {
      refreshes++;
    },
    timers: createNodeTimers(),
    logger: new MemoryLogger(),
  });
  const d = makeDevice(root, { host: { workingCopy } });
  const nv = newVaultSeed(d);
  replica = (await open(d, nv.lineageId, nv.key, nv.seed, null)).replica;
});

afterEach(() => {
  replica?.close();
  replica = null;
  vault.lock();
  fs.rmSync(root, { recursive: true, force: true });
});

function r(): ReplicaPort {
  if (replica === null) throw new Error('test: replica closed');
  return replica;
}

describe('ConduitVault over a replica working copy', () => {
  it('captures vault edits in the mutator transaction and notifies the engine after commit', () => {
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.getFilePath()).toBe(path.join(root, 'Shared.conduit'));
    const commits: VaultMutationInfo[] = [];
    r().onLocalCommit((m) => commits.push(m));
    const gen0 = r().generation();

    const e = vault.createEntry({ name: 'web box', entry_type: 'ssh', host: '10.0.0.1' });
    expect(r().generation()).toBe(gen0 + 1);
    expect(provisionalOf(r().state(), e.id, 'name')?.value).toBe('web box');
    vault.updateEntry(e.id, { host: '10.0.0.2' });
    expect(provisionalOf(r().state(), e.id, 'host')?.value).toBe('10.0.0.2');
    expect(commits.map((c) => c.rows)).toEqual([[{ tbl: TBL.entries, rowId: e.id }], [{ tbl: TBL.entries, rowId: e.id }]]);

    vault.deleteEntry(e.id);
    expect(rowLife(r().state(), { tbl: TBL.entries, rowId: e.id })).toBe('dead');
  });

  it('captures secrets written with the working-copy key and reads them back', () => {
    const e = vault.createEntry({ name: 'db', entry_type: 'credential', password: 's3cret' });
    vault.recordPasswordHistory(e.id, null, 'older', null);
    expect(vault.getEntry(e.id).password).toBe('s3cret');
    expect(rowLife(r().state(), { tbl: TBL.entries, rowId: e.id })).toBe('live');
    expect(vault.listPasswordHistory(e.id).map((h) => h.password)).toEqual(['older']);
  });

  it('a capture the replica refuses leaves W unchanged', () => {
    const e = vault.createEntry({ name: 'keep', entry_type: 'ssh' });
    const gen = r().generation();
    vault.setSyncHooks({
      captureInTransaction: () => {
        throw new Error('refused');
      },
      afterCommit: () => undefined,
      requestFullPass: () => undefined,
    });
    expect(() => vault.updateEntry(e.id, { name: 'lost' })).toThrow('refused');
    expect(vault.getEntryMeta(e.id).name).toBe('keep');
    expect(r().generation()).toBe(gen);
  });

  it('closing the replica locks the vault and removes the hooks', () => {
    r().close();
    replica = null;
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getWorkingPath()).toBeNull();
    expect(refreshes).toBe(0);
  });
});
