// @vitest-environment node
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIpc, fakeEngineVault, silenceConsole } from './sync-fakes.js';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() } }));
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: () => ({}) } }));
vi.mock('../sync-password.js', () => ({ applyVaultPasswordChange: vi.fn() }));
vi.mock('../../services/sync/app-sync-actions.js', () => ({
  syncNow: vi.fn(),
  listDevices: vi.fn(),
  listCopies: vi.fn(),
  copyAction: vi.fn(async () => ({ candidateId: null })),
  confirmSideFiles: vi.fn(),
  locate: vi.fn(),
  saveNewCopy: vi.fn(),
  undoRebind: vi.fn(),
  makeSeparateVault: vi.fn(),
  dismissPrompt: vi.fn(),
  dismissNotice: vi.fn(),
  enterNewPassword: vi.fn(),
  adoptLegacyPassword: vi.fn(),
  resolveConcurrentEpoch: vi.fn(async () => ({ ok: true })),
}));

const actions = await import('../../services/sync/app-sync-actions.js');
const { COPY_GONE_MESSAGE, registerSyncHandlers } = await import('../sync.js');
const { SYNC_NOT_RUNNING_MESSAGE } = await import('../../services/sync/app-sync-manager.js');
const { GENERIC_SYNC_ERROR_MESSAGE } = await import('../sync-errors.js');

const COPY = path.resolve('/tmp/sync/Work (conflicted copy).conduit');

function setup(opts: { engine?: boolean } = {}) {
  const vault = fakeEngineVault({ copies: [{ path: COPY }], ownEpoch: 'epoch-own' });
  const appSync = {
    getState: vi.fn(async () => ({ enabled: true })),
    engineVault: vi.fn(() => {
      if (opts.engine === false) throw new Error(SYNC_NOT_RUNNING_MESSAGE);
      return vault;
    }),
    runtime: vi.fn(),
    exportUnsynced: vi.fn(async () => '/tmp/exports/Work (unsynced changes).conduit'),
    setEnabled: vi.fn(async (enabled: unknown) => ({ ok: true, enabled })),
    answerConflict: vi.fn(async () => {}),
    stopWaiting: vi.fn(async () => {}),
    openNow: vi.fn(),
  };
  const deps = { appSync: () => appSync as never, passwordChanged: vi.fn(async () => {}), showItemInFolder: vi.fn() };
  const ipc = new FakeIpc();
  registerSyncHandlers(deps, ipc);
  return { ipc, appSync, deps, vault };
}

beforeEach(() => {
  vi.clearAllMocks();
  silenceConsole();
});

describe('sync IPC channels', () => {
  it('registers every sync channel', () => {
    const { ipc } = setup();
    expect([...ipc.handlers.keys()].sort()).toEqual(
      [
        'sync_get_state', 'sync_now', 'sync_list_devices', 'sync_list_copies', 'sync_copy_action', 'sync_confirm_side_files',
        'sync_review_side_file_wal', 'sync_locate_file', 'sync_save_new_copy', 'sync_undo_rebind', 'sync_make_separate_vault',
        'sync_export_unsynced', 'sync_dismiss_prompt', 'sync_dismiss_notice', 'sync_set_enabled', 'sync_enter_new_password',
        'sync_adopt_legacy_password', 'sync_resolve_concurrent_epoch', 'vault_session_takeover', 'vault_session_lock_here',
        'vault_session_stop_waiting', 'vault_session_open_now',
      ].sort(),
    );
  });

  it('passes the not-running message through when no engine runs', async () => {
    const { ipc } = setup({ engine: false });
    await expect(ipc.invoke('sync_now')).rejects.toThrow(SYNC_NOT_RUNNING_MESSAGE);
  });

  it('rejects malformed arguments before the sync layer runs', async () => {
    const { ipc, appSync } = setup();
    await expect(ipc.invoke('sync_list_copies', 'rescan')).rejects.toThrow('Invalid sync request: arguments');
    await expect(ipc.invoke('sync_set_enabled', { enabled: 'no' })).rejects.toThrow('Invalid sync request: enabled');
    await expect(ipc.invoke('sync_make_separate_vault', { targetPath: path.resolve('/tmp/notes.txt') })).rejects.toThrow(
      'Invalid sync request: the file name must end in .conduit',
    );
    expect(appSync.setEnabled).not.toHaveBeenCalled();
    expect(actions.makeSeparateVault).not.toHaveBeenCalled();
  });

  it('hides internal error text behind a short message', async () => {
    const { ipc } = setup();
    vi.mocked(actions.syncNow).mockRejectedValueOnce(new Error('[sync] engine stopped'));
    await expect(ipc.invoke('sync_now')).rejects.toThrow(GENERIC_SYNC_ERROR_MESSAGE);
  });

  it('acts only on copies the engine found', async () => {
    const { ipc } = setup();
    await expect(ipc.invoke('sync_copy_action', { path: path.resolve('/Users/me/.ssh/id_ed25519'), action: 'trash' })).rejects.toThrow(
      COPY_GONE_MESSAGE,
    );
    expect(actions.copyAction).not.toHaveBeenCalled();
    await ipc.invoke('sync_copy_action', { path: COPY, action: 'trash' });
    expect(actions.copyAction).toHaveBeenCalledWith(expect.anything(), COPY, 'trash', null);
  });

  it('exports unsynced changes and shows the file', async () => {
    const { ipc, deps } = setup();
    await expect(ipc.invoke('sync_export_unsynced', {})).resolves.toEqual({ path: '/tmp/exports/Work (unsynced changes).conduit' });
    expect(deps.showItemInFolder).toHaveBeenCalledWith('/tmp/exports/Work (unsynced changes).conduit');
  });

  it('lets the app follow a new password only when the flow succeeded', async () => {
    const { ipc, deps } = setup();
    vi.mocked(actions.enterNewPassword).mockResolvedValueOnce({ ok: false, reason: 'wrong-password' });
    await ipc.invoke('sync_enter_new_password', { password: 'typo' });
    expect(deps.passwordChanged).not.toHaveBeenCalled();
    vi.mocked(actions.enterNewPassword).mockResolvedValueOnce({ ok: true });
    await ipc.invoke('sync_enter_new_password', { password: 'new-pass' });
    expect(deps.passwordChanged).toHaveBeenCalledWith('new-pass');
  });

  it('follows the other password only when its epoch won', async () => {
    const { ipc, deps } = setup();
    await ipc.invoke('sync_resolve_concurrent_epoch', { otherPassword: 'other', winnerEpochId: 'epoch-own' });
    expect(deps.passwordChanged).not.toHaveBeenCalled();
    await ipc.invoke('sync_resolve_concurrent_epoch', { otherPassword: 'other', winnerEpochId: 'epoch-other' });
    expect(deps.passwordChanged).toHaveBeenCalledWith('other');
  });

  it('forwards the device-session answers', async () => {
    const { ipc, appSync } = setup();
    await ipc.invoke('vault_session_takeover');
    await ipc.invoke('vault_session_lock_here');
    await ipc.invoke('vault_session_stop_waiting', { deviceId: 'device-2' });
    await ipc.invoke('vault_session_open_now');
    expect(appSync.answerConflict).toHaveBeenNthCalledWith(1, 'use-here');
    expect(appSync.answerConflict).toHaveBeenNthCalledWith(2, 'lock-here');
    expect(appSync.stopWaiting).toHaveBeenCalledWith('device-2');
    expect(appSync.openNow).toHaveBeenCalled();
    await expect(ipc.invoke('vault_session_stop_waiting', {})).rejects.toThrow('Invalid sync request: device');
  });
});
