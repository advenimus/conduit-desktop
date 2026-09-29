// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { silenceConsole } from './sync-fakes.js';
import {
  NOT_UNLOCKED_MESSAGE,
  PROOF_EXPIRED_MESSAGE,
  TOUCH_ID_FAILED_MESSAGE,
  WRONG_PASSWORD_MESSAGE,
  enableAutoUnlock,
  parseProof,
  samePassword,
  type EnableDeps,
} from '../auto-unlock-enable.js';
import type { StartupVault } from '../startup-vault-core.js';
import type { SealResult, SecretStoreStatus } from '../../services/vault/auto-unlock-store.js';

interface World {
  unlocked: boolean;
  recent: string | null;
  bioOn: boolean;
  bioOk: boolean;
  status: SecretStoreStatus;
  sealed: { lineageId: string; userId: string | null; password: string }[];
  sealResult: SealResult;
  startup: StartupVault | null;
}

let w: World;

function deps(): EnableDeps {
  return {
    store: {
      status: () => w.status,
      dir: () => '/x',
      sealPassword: async (lineageId, userId, password) => {
        if (w.sealResult.ok) w.sealed.push({ lineageId, userId, password });
        return w.sealResult;
      },
      readPassword: () => ({ kind: 'missing' }),
      hasEntry: () => false,
      removeEntry: () => false,
      removeAll: () => 0,
      removeAllExcept: () => 0,
    },
    isPersonalUnlocked: () => w.unlocked,
    currentPath: () => '/v/Work.conduit',
    currentLineage: async () => 'L1',
    masterPassword: () => (w.unlocked ? 'held-pw' : null),
    hasRecentUnlock: (l) => w.recent === l,
    clearRecentUnlock: () => {
      w.recent = null;
    },
    biometricEnabledForCurrent: async () => w.bioOn,
    authenticateBiometric: async () => w.bioOk,
    userId: () => 'user-a',
    writeStartup: (sv) => {
      w.startup = sv;
    },
  };
}

beforeEach(() => {
  silenceConsole();
  w = {
    unlocked: true,
    recent: 'L1',
    bioOn: true,
    bioOk: true,
    status: { usable: true, reason: 'ok', backend: 'keychain', storeName: 'system keychain' },
    sealed: [],
    sealResult: { ok: true },
    startup: null,
  };
});

describe('auto_unlock_enable proofs (spec 5.4)', () => {
  it('a recent unlock of this vault is accepted once', async () => {
    await enableAutoUnlock(deps(), { kind: 'recent-unlock' });
    expect(w.sealed).toEqual([{ lineageId: 'L1', userId: 'user-a', password: 'held-pw' }]);
    expect(w.startup).toEqual({ kind: 'personal', path: '/v/Work.conduit', lineageId: 'L1' });
    await expect(enableAutoUnlock(deps(), { kind: 'recent-unlock' })).rejects.toThrow(PROOF_EXPIRED_MESSAGE);
  });

  it('a failed save keeps the recent unlock so Turn On can be tried again', async () => {
    w.sealResult = { ok: false, reason: 'write-failed' };
    await expect(enableAutoUnlock(deps(), { kind: 'recent-unlock' })).rejects.toThrow("Conduit couldn't save the unlock. Try again.");
    expect(w.recent).toBe('L1');
    w.status = { usable: false, reason: 'weak', backend: 'basic_text', storeName: 'system keyring' };
    await expect(enableAutoUnlock(deps(), { kind: 'recent-unlock' })).rejects.toThrow('system keyring');
    expect(w.recent).toBe('L1');
    w.status = { usable: true, reason: 'ok', backend: 'keychain', storeName: 'system keychain' };
    w.sealResult = { ok: true };
    await enableAutoUnlock(deps(), { kind: 'recent-unlock' });
    expect(w.sealed).toHaveLength(1);
    expect(w.recent).toBeNull();
  });

  it('the password proof compares with the held password and seals the held one', async () => {
    await expect(enableAutoUnlock(deps(), { kind: 'password', password: 'nope' })).rejects.toThrow(WRONG_PASSWORD_MESSAGE);
    expect(w.sealed).toEqual([]);
    await enableAutoUnlock(deps(), { kind: 'password', password: 'held-pw' });
    expect(w.sealed[0].password).toBe('held-pw');
  });

  it('Touch ID needs Quick Unlock on and a successful prompt', async () => {
    w.bioOk = false;
    await expect(enableAutoUnlock(deps(), { kind: 'biometric' })).rejects.toThrow(TOUCH_ID_FAILED_MESSAGE);
    w.bioOk = true;
    w.bioOn = false;
    await expect(enableAutoUnlock(deps(), { kind: 'biometric' })).rejects.toThrow(TOUCH_ID_FAILED_MESSAGE);
    w.bioOn = true;
    await enableAutoUnlock(deps(), { kind: 'biometric' });
    expect(w.sealed).toHaveLength(1);
  });

  it('refuses a locked vault and a weak store, and changes nothing', async () => {
    w.unlocked = false;
    await expect(enableAutoUnlock(deps(), { kind: 'recent-unlock' })).rejects.toThrow(NOT_UNLOCKED_MESSAGE);
    w.unlocked = true;
    w.status = { usable: false, reason: 'weak', backend: 'basic_text', storeName: 'system keyring' };
    await expect(enableAutoUnlock(deps(), { kind: 'password', password: 'held-pw' })).rejects.toThrow('system keyring');
    expect(w.startup).toBeNull();
  });

  it('parses only the three proofs', () => {
    expect(parseProof({ proof: { kind: 'recent-unlock' } })).toEqual({ kind: 'recent-unlock' });
    expect(parseProof({ proof: { kind: 'password', password: 'x' } })).toEqual({ kind: 'password', password: 'x' });
    expect(() => parseProof({ proof: { kind: 'password' } })).toThrow();
    expect(() => parseProof({})).toThrow();
  });

  it('samePassword is exact', () => {
    expect(samePassword('abc', 'abc')).toBe(true);
    expect(samePassword('abc', 'abcd')).toBe(false);
  });
});
