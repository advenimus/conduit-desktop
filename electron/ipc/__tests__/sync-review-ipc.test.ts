// @vitest-environment node
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIpc, silenceConsole } from './sync-fakes.js';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: () => ({}) } }));
vi.mock('../../services/sync/app-sync-review.js', () => ({
  listConflictGroups: vi.fn(() => []),
  resolve: vi.fn(async () => ({ conflictCount: 0 })),
  resolveGroup: vi.fn(async () => ({ conflictCount: 0 })),
  snooze: vi.fn(() => ({ conflictCount: 0 })),
  reveal: vi.fn(() => 'hunter2'),
  recoverSecret: vi.fn(async () => true),
  listCandidates: vi.fn(() => []),
  candidatePreview: vi.fn(),
  candidateApply: vi.fn(),
  candidateDiscard: vi.fn(),
  candidateAddFile: vi.fn(async () => 'candidate-7'),
  heldApply: vi.fn(),
  listSnapshots: vi.fn(),
  undoPreview: vi.fn(),
  undoApply: vi.fn(async () => ({ applied: 0 })),
  recentlyDeleted: vi.fn(() => []),
  restoreDeleted: vi.fn(),
  deleteForever: vi.fn(async () => {}),
}));

const review = await import('../../services/sync/app-sync-review.js');
const { registerSyncReviewHandlers } = await import('../sync-review.js');

const VAULT = { engine: {}, replica: {} };

function setup() {
  const ipc = new FakeIpc();
  registerSyncReviewHandlers({ engineVault: () => VAULT as never }, ipc);
  return ipc;
}

beforeEach(() => {
  vi.clearAllMocks();
  silenceConsole();
});

describe('sync review IPC channels', () => {
  it('registers every review channel', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(
      [
        'sync_list_conflicts', 'sync_resolve', 'sync_resolve_group', 'sync_snooze', 'sync_reveal_secret',
        'sync_recover_undecryptable', 'sync_candidate_list', 'sync_candidate_preview', 'sync_candidate_apply',
        'sync_candidate_discard', 'sync_candidate_add_file', 'sync_held_apply', 'sync_list_snapshots', 'sync_undo_preview',
        'sync_undo_apply', 'sync_recently_deleted', 'sync_restore_deleted', 'sync_delete_permanently',
      ].sort(),
    );
  });

  it('wraps reveal and recovery results as the contract says', async () => {
    const ipc = setup();
    const key = { tbl: 1, rowId: 'e1', reg: 'password' };
    await expect(ipc.invoke('sync_reveal_secret', { key, versionId: 'v1' })).resolves.toEqual({ plaintext: 'hunter2' });
    await expect(ipc.invoke('sync_recover_undecryptable', { key, versionId: 'v1', oldPassword: 'old' })).resolves.toEqual({ ok: true });
    await expect(ipc.invoke('sync_recover_undecryptable', { key, versionId: 'v1' })).rejects.toThrow('Invalid sync request: password');
    await expect(ipc.invoke('sync_candidate_add_file', { path: path.resolve('/tmp/copy.conduit') })).resolves.toEqual({
      candidateId: 'candidate-7',
    });
  });

  it('validates the request objects and choices', async () => {
    const ipc = setup();
    await expect(ipc.invoke('sync_resolve', { request: 'keep' })).rejects.toThrow('Invalid sync request: request');
    await expect(ipc.invoke('sync_held_apply', { choice: 'maybe' })).rejects.toThrow('Invalid sync request: held choice');
    await expect(ipc.invoke('sync_candidate_add_file', { path: 'copy.conduit' })).rejects.toThrow('Invalid sync request: file');
    expect(review.resolve).not.toHaveBeenCalled();
    expect(review.heldApply).not.toHaveBeenCalled();
  });

  it('deletes permanently only chosen rows or everything with all', async () => {
    const ipc = setup();
    await expect(ipc.invoke('sync_delete_permanently', {})).rejects.toThrow('Invalid sync request: rows');
    await expect(ipc.invoke('sync_delete_permanently', { rows: [] })).rejects.toThrow('Invalid sync request: rows');
    await ipc.invoke('sync_delete_permanently', { all: true });
    expect(review.deleteForever).toHaveBeenLastCalledWith(VAULT, undefined, true);
    const rows = [{ tbl: 1, rowId: 'e1' }];
    await ipc.invoke('sync_delete_permanently', { rows });
    expect(review.deleteForever).toHaveBeenLastCalledWith(VAULT, rows, false);
  });

  it('defaults the undo selection to nothing', async () => {
    const ipc = setup();
    await ipc.invoke('sync_undo_apply', { snapshotId: 's1' });
    expect(review.undoApply).toHaveBeenCalledWith(VAULT, 's1', [], []);
  });
});
