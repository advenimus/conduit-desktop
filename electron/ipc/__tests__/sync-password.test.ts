// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

const bio = vi.hoisted(() => ({ enabled: new Set<string>(), storePassword: vi.fn(async () => {}), removePassword: vi.fn() }));

vi.mock('../vault.js', () => ({ wireBackupServices: vi.fn() }));
vi.mock('../../services/vault/biometric.js', () => ({
  vaultLineageToKey: (id: string) => `lineage:${id}`,
  vaultPathToKey: (p: string) => `path:${p}`,
  moveKey: vi.fn(),
  getBiometricService: () => ({ isEnabledForVault: (k: string) => bio.enabled.has(k), storePassword: bio.storePassword, removePassword: bio.removePassword }),
}));

const { wireBackupServices } = await import('../vault.js');
const { applyVaultPasswordChange } = await import('../sync-password.js');

function fakeState(previous: string | null, chatUnlocked: boolean) {
  const chatStore = { isUnlocked: () => chatUnlocked, exists: () => true, changePassword: vi.fn(), unlock: vi.fn() };
  return {
    currentMasterPassword: previous,
    currentVaultPath: '/vaults/Work.conduit',
    chatStore,
    appSync: { currentLineageId: () => 'L1', lineageForPath: async () => 'L1' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  silenceConsole();
  bio.enabled.clear();
});

describe('app follow-up after a sync password change', () => {
  it('rekeys the chat store, rewires backups and updates the biometric entry', async () => {
    bio.enabled.add('lineage:L1');
    const state = fakeState('old', true);
    await applyVaultPasswordChange(state as never, 'new');
    expect(state.chatStore.changePassword).toHaveBeenCalledWith('old', 'new');
    expect(state.currentMasterPassword).toBe('new');
    expect(wireBackupServices).toHaveBeenCalledWith(state, 'new');
    expect(bio.storePassword).toHaveBeenCalledTimes(1);
    expect(bio.storePassword).toHaveBeenCalledWith('lineage:L1', 'new');
  });

  it('moves a legacy path-keyed entry to the lineage key, like vault_change_password', async () => {
    bio.enabled.add('lineage:L1');
    bio.enabled.add('path:/vaults/Work.conduit');
    await applyVaultPasswordChange(fakeState('old', true) as never, 'new');
    expect(bio.storePassword).toHaveBeenCalledTimes(1);
    expect(bio.storePassword).toHaveBeenCalledWith('lineage:L1', 'new');
    expect(bio.removePassword).toHaveBeenCalledWith('path:/vaults/Work.conduit');
  });

  it('does nothing when the password did not change', async () => {
    const state = fakeState('same', true);
    await applyVaultPasswordChange(state as never, 'same');
    expect(wireBackupServices).not.toHaveBeenCalled();
  });

  it('keeps going when the chat store refuses', async () => {
    const state = fakeState('old', true);
    state.chatStore.changePassword.mockImplementation(() => {
      throw new Error('Current password is incorrect for chat database');
    });
    await applyVaultPasswordChange(state as never, 'new');
    expect(wireBackupServices).toHaveBeenCalledWith(state, 'new');
  });
});
