// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConduitVault, SYNC_MANAGED_PASSWORD_MESSAGE, VaultLockedError, type VaultMutation } from '../vault.js';
import type { VaultMutationInfo, VaultSyncHooks } from '../../sync/host.js';
import { TBL, type RowKey } from '../../sync/types.js';

interface Capture {
  readonly info: VaultMutationInfo;
  readonly inTransaction: boolean;
}

class RecordingHooks implements VaultSyncHooks {
  readonly captures: Capture[] = [];
  readonly commits: { readonly info: VaultMutationInfo; readonly inTransaction: boolean }[] = [];
  readonly fullPasses: string[] = [];
  failNext = false;

  constructor(private readonly vault: ConduitVault) {}

  captureInTransaction(info: VaultMutationInfo): void {
    this.captures.push({ info, inTransaction: this.vault.getDatabase().raw().inTransaction });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('capture failed');
    }
  }

  afterCommit(info: VaultMutationInfo): void {
    this.commits.push({ info, inTransaction: this.vault.getDatabase().raw().inTransaction });
  }

  requestFullPass(reason: string): void {
    this.fullPasses.push(reason);
  }

  lastRows(): readonly RowKey[] {
    const last = this.captures[this.captures.length - 1];
    if (last === undefined) throw new Error('no capture');
    return last.info.rows;
  }
}

const entry = (rowId: string): RowKey => ({ tbl: TBL.entries, rowId });
const folder = (rowId: string): RowKey => ({ tbl: TBL.folders, rowId });
const history = (rowId: string): RowKey => ({ tbl: TBL.history, rowId });

let dir: string;
let vault: ConduitVault;
let hooks: RecordingHooks;
let mutations: VaultMutation[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-vault-hooks-'));
  vault = new ConduitVault(path.join(dir, 'v.conduit'));
  vault.initialize('pw');
  hooks = new RecordingHooks(vault);
  vault.setSyncHooks(hooks);
  mutations = [];
  vault.setOnMutation((m) => mutations.push(m));
});

afterEach(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

function countEntries(): number {
  return vault.listEntries().length;
}

describe('every mutator captures inside its transaction', () => {
  it('folders, entries, history and the wrappers capture their rows, then notify after commit', () => {
    const f = vault.createFolder({ name: 'F' });
    expect(hooks.lastRows()).toEqual([folder(f.id)]);
    vault.updateFolder(f.id, { name: 'F2' });
    expect(hooks.lastRows()).toEqual([folder(f.id)]);

    const e = vault.createEntry({ name: 'E', entry_type: 'ssh', password: 'secret' });
    expect(hooks.lastRows()).toEqual([entry(e.id)]);
    vault.updateEntry(e.id, { host: 'h' });
    expect(hooks.lastRows()).toEqual([entry(e.id)]);
    const dup = vault.duplicateEntry(e.id);
    expect(hooks.lastRows()).toEqual([entry(dup.id)]);
    vault.moveEntry(e.id, f.id);
    expect(hooks.lastRows()).toEqual([entry(e.id)]);

    const h = vault.recordPasswordHistory(e.id, 'u', 'old', null);
    expect(hooks.lastRows()).toEqual([history(h)]);
    vault.deletePasswordHistory(h);
    expect(hooks.lastRows()).toEqual([history(h)]);

    const cred = vault.createCredential({ name: 'C', password: 'p' });
    expect(hooks.lastRows()).toEqual([entry(cred.id)]);
    vault.updateCredential(cred.id, { password: 'p2' });
    expect(hooks.lastRows()).toEqual([entry(cred.id)]);
    vault.deleteCredential(cred.id);
    expect(hooks.lastRows()).toEqual([entry(cred.id)]);

    expect(hooks.captures.length).toBe(11);
    expect(hooks.captures.every((c) => c.inTransaction)).toBe(true);
    expect(hooks.captures.every((c) => c.info.interactive)).toBe(true);
    expect(hooks.commits.map((c) => c.info)).toEqual(hooks.captures.map((c) => c.info));
    expect(hooks.commits.every((c) => !c.inTransaction)).toBe(true);
    expect(mutations).toHaveLength(11);
  });

  it('deleteEntry captures the entry, promoted children and its password history', () => {
    const parent = vault.createEntry({ name: 'P', entry_type: 'ssh' });
    const child = vault.createEntry({ name: 'C', entry_type: 'ssh', parent_entry_id: parent.id });
    const h = vault.recordPasswordHistory(parent.id, null, 'old', null);
    vault.deleteEntry(parent.id);
    expect(hooks.lastRows()).toEqual([entry(parent.id), entry(child.id), history(h)]);
    expect(vault.getEntryMeta(child.id).parent_entry_id).toBeNull();
  });

  it('deleteFolder captures every deleted folder, entry and history row', () => {
    const top = vault.createFolder({ name: 'Top' });
    const sub = vault.createFolder({ name: 'Sub', parent_id: top.id });
    const e1 = vault.createEntry({ name: 'E1', entry_type: 'ssh', folder_id: sub.id });
    const e2 = vault.createEntry({ name: 'E2', entry_type: 'ssh', parent_entry_id: e1.id });
    const h = vault.recordPasswordHistory(e2.id, null, 'old', null);
    vault.deleteFolder(top.id);
    const rows = hooks.lastRows();
    expect(rows).toEqual(expect.arrayContaining([folder(top.id), folder(sub.id), entry(e1.id), entry(e2.id), history(h)]));
    expect(rows).toHaveLength(5);
    expect(countEntries()).toBe(0);
  });
});

describe('a failed capture rolls the mutation back', () => {
  it('leaves content unchanged and skips afterCommit and the mutation callback', () => {
    const e = vault.createEntry({ name: 'Keep', entry_type: 'ssh' });
    const before = { commits: hooks.commits.length, mutations: mutations.length };

    hooks.failNext = true;
    expect(() => vault.createEntry({ name: 'Lost', entry_type: 'ssh' })).toThrow('capture failed');
    expect(countEntries()).toBe(1);

    hooks.failNext = true;
    expect(() => vault.updateEntry(e.id, { name: 'Renamed' })).toThrow('capture failed');
    expect(vault.getEntryMeta(e.id).name).toBe('Keep');

    hooks.failNext = true;
    expect(() => vault.deleteEntry(e.id)).toThrow('capture failed');
    expect(countEntries()).toBe(1);

    expect(hooks.commits.length).toBe(before.commits);
    expect(mutations.length).toBe(before.mutations);
  });

  it('rolls back a recursive folder delete', () => {
    const f = vault.createFolder({ name: 'F' });
    vault.createEntry({ name: 'E', entry_type: 'ssh', folder_id: f.id });
    hooks.failNext = true;
    expect(() => vault.deleteFolder(f.id)).toThrow('capture failed');
    expect(vault.listFolders()).toHaveLength(1);
    expect(countEntries()).toBe(1);
  });

  it('a throwing afterCommit does not fail a committed mutation', () => {
    hooks.afterCommit = () => {
      throw new Error('late');
    };
    const e = vault.createEntry({ name: 'E', entry_type: 'ssh' });
    expect(vault.getEntryMeta(e.id).name).toBe('E');
  });
});

describe('interactive flag, full passes, access block', () => {
  it('runNonInteractive marks captures non-interactive and restores the flag', () => {
    vault.runNonInteractive(() => {
      vault.createEntry({ name: 'MCP', entry_type: 'document' });
      vault.runNonInteractive(() => vault.createEntry({ name: 'Nested', entry_type: 'document' }));
      vault.createEntry({ name: 'After nested', entry_type: 'document' });
    });
    vault.createEntry({ name: 'Editor', entry_type: 'document' });
    expect(hooks.captures.map((c) => c.info.interactive)).toEqual([false, false, false, true]);
  });

  it('vault_meta writes ask for a full pass', () => {
    vault.getVaultId();
    vault.getVaultId();
    vault.setCloudSyncEnabled(true);
    vault.setTeamVaultId('t');
    expect(hooks.fullPasses).toEqual(['vault-meta', 'vault-meta', 'vault-meta']);
  });

  it('a blocked vault refuses reads and writes with the reason; lock() lifts the block and drops hooks', () => {
    vault.blockAccess('open_elsewhere');
    expect(() => vault.listEntries()).toThrow(VaultLockedError);
    const err = (() => {
      try {
        vault.createEntry({ name: 'X', entry_type: 'ssh' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(VaultLockedError);
    expect((err as VaultLockedError).reason).toBe('open_elsewhere');
    expect((err as Error).message).toBe('Vault is locked');
    vault.lock();
    vault.unlock('pw');
    expect(vault.listEntries()).toEqual([]);
    vault.createEntry({ name: 'No hooks', entry_type: 'ssh' });
    expect(hooks.captures).toHaveLength(0);
  });
});

describe('working copy', () => {
  it('opens W with the given key, keeps the shared path, and refuses in-place password changes', () => {
    const shared = vault.getFilePath();
    const key = vault.getEncryptionKey();
    const keyCopy = Buffer.from(key);
    vault.lock();
    const w = path.join(dir, 'w.conduit');
    const db = vault.openWorkingCopy({ path: w, key: keyCopy, journalMode: 'delete', create: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(vault.getFilePath()).toBe(shared);
    expect(vault.getWorkingPath()).toBe(w);
    const e = vault.createEntry({ name: 'In W', entry_type: 'ssh', password: 'x' });
    expect(vault.getEntry(e.id).password).toBe('x');
    expect(() => vault.changePassword('pw', 'new')).toThrow(SYNC_MANAGED_PASSWORD_MESSAGE);
    expect(() => vault.rekey(Buffer.alloc(32, 1))).toThrow(SYNC_MANAGED_PASSWORD_MESSAGE);
    vault.reloadFromDisk();
    expect(vault.getEntryMeta(e.id).name).toBe('In W');
    expect(() => vault.openWorkingCopy({ path: w, key: keyCopy, journalMode: 'wal', create: false })).toThrow('Vault is already unlocked');
    vault.lock();
    expect(vault.getWorkingPath()).toBeNull();
    expect(() => vault.openWorkingCopy({ path: w, key: keyCopy, journalMode: 'wal', create: true })).toThrow('Vault file already exists');
    expect(() => vault.openWorkingCopy({ path: path.join(dir, 'missing.conduit'), key: keyCopy, journalMode: 'wal', create: false })).toThrow(
      'Vault file not found',
    );
  });

  it('setSyncKey switches the key used for new secrets', () => {
    const next = Buffer.alloc(32, 7);
    vault.setSyncKey(next);
    next.fill(0);
    const e = vault.createEntry({ name: 'E', entry_type: 'ssh', password: 'after' });
    expect(vault.getEntry(e.id).password).toBe('after');
    expect(vault.getEncryptionKey().equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('rekey keeps updated_at (re-encryption is not an edit)', () => {
    vault.setSyncHooks(null);
    const e = vault.createEntry({ name: 'E', entry_type: 'ssh', password: 'p' });
    const old = '2020-01-01T00:00:00.000Z';
    vault.getDatabase().raw().prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(old, e.id);
    vault.changePassword('pw', 'pw2');
    expect(vault.getEntryMeta(e.id).updated_at).toBe(old);
    expect(vault.getEntry(e.id).password).toBe('p');
  });
});
