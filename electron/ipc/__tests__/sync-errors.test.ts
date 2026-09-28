// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FakeIpc, silenceConsole } from './sync-fakes.js';

const { GENERIC_SYNC_ERROR_MESSAGE, UserFacingError, handleChannel, userMessage } = await import('../sync-errors.js');
const { InvalidSyncRequest } = await import('../../services/sync/app-sync-dto-map.js');
const { SyncCoreError } = await import('../../services/sync/types.js');
const { PersonalVaultOpenError } = await import('../../services/vault-session/open-personal-vault.js');

describe('sync error messages', () => {
  it('passes user-facing text through', () => {
    expect(userMessage(new UserFacingError('Pick another folder.'))).toBe('Pick another folder.');
    expect(userMessage(new InvalidSyncRequest('rows'))).toBe('Invalid sync request: rows');
    expect(userMessage(new Error('Invalid master password'))).toBe('Invalid master password');
  });

  it('keeps structured unlock errors as JSON for the renderer', () => {
    const err = new PersonalVaultOpenError({ code: 'VAULT_WORKING_COPY_DAMAGED', fileName: 'Work.conduit', recoverable: true });
    expect(JSON.parse(userMessage(err))).toMatchObject({ code: 'VAULT_WORKING_COPY_DAMAGED', recoverable: true });
  });

  it('words core and file-system errors, and hides everything else', () => {
    expect(userMessage(new SyncCoreError('KEY_MISMATCH', 'the other epoch has no salt'))).toBe('That password does not open this vault.');
    expect(userMessage(Object.assign(new Error('EACCES: /x'), { code: 'EACCES' }))).toBe('Conduit does not have permission to use that file or folder.');
    expect(userMessage(new Error('conflict resolution: unknown row 1/e1'))).toBe(GENERIC_SYNC_ERROR_MESSAGE);
    expect(userMessage('boom', 'Custom.')).toBe('Custom.');
  });

  it('logs the detail and throws the short message over IPC', async () => {
    silenceConsole();
    const ipc = new FakeIpc();
    handleChannel(ipc, 'demo', () => {
      throw new Error('[sync] engine stopped');
    });
    await expect(ipc.invoke('demo', {})).rejects.toThrow(GENERIC_SYNC_ERROR_MESSAGE);
    expect(console.error).toHaveBeenCalledWith('[sync] demo failed', expect.objectContaining({ message: '[sync] engine stopped' }), expect.any(String));
    vi.restoreAllMocks();
  });
});
