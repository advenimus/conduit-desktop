// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

type Handler = (event: unknown, args: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const removed: string[] = [];

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } }));
vi.mock('../../services/vault/biometric.js', () => ({
  getBiometricService: () => ({
    isAvailable: () => true,
    isEnabledForVault: () => true,
    retrievePassword: async () => 'old-password',
    storePassword: async () => undefined,
    removePassword: (key: string) => removed.push(key),
  }),
  moveKey: () => undefined,
  vaultLineageToKey: (l: string) => `lineage:${l}`,
  vaultPathToKey: (p: string) => `path:${p}`,
}));
vi.mock('../settings.js', () => ({
  readSettings: () => ({}),
  writeSettings: () => undefined,
  updateRecentVaults: () => undefined,
  updateLastVaultContext: () => undefined,
}));
vi.mock('../vault-wiring.js', () => ({ completePersonalUnlock: () => undefined }));
vi.mock('../vault-lock-flow.js', () => ({ lockPersonalVault: async () => undefined }));
vi.mock('../../services/vault/migration.js', () => ({ migrateToConduit: () => undefined }));

const { changedElsewhereError, INVALID_PASSWORD_MESSAGE } = await import('../../services/vault-session/open-errors.js');
let openError: Error = new Error('unset');
const fakeState = {
  currentVaultPath: '/cloud/Vault.conduit',
  appSync: {
    lineageForPath: async () => 'L1',
    currentLineageId: () => null,
    openPersonalVault: async () => {
      throw openError;
    },
  },
};
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: () => fakeState } }));

const { registerBiometricHandlers } = await import('../biometric.js');

beforeEach(() => {
  silenceConsole();
  handlers.clear();
  removed.length = 0;
  registerBiometricHandlers();
});

async function unlockError(): Promise<Error> {
  return (await handlers.get('biometric_unlock')!(null, {}).catch((e: unknown) => e)) as Error;
}

describe('biometric_unlock after a password change elsewhere (spec 4.8, 6.3)', () => {
  it('removes the superseded entry and still sends the structured error', async () => {
    openError = changedElsewhereError({ changedByDeviceName: 'MacBook', changedMs: 1, needsPreviousPassword: false, deleteBiometric: true });
    const err = await unlockError();
    expect(JSON.parse(err.message)).toMatchObject({ code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE', deleteBiometric: true });
    expect(err.name).toBe('Error');
    expect(removed).toEqual(expect.arrayContaining(['lineage:L1']));
  });

  it('keeps the entry for other refusals', async () => {
    openError = changedElsewhereError({ changedByDeviceName: 'MacBook', changedMs: 1, needsPreviousPassword: true, deleteBiometric: false });
    await unlockError();
    openError = new Error(INVALID_PASSWORD_MESSAGE);
    await unlockError();
    expect(removed).toEqual([]);
  });
});
