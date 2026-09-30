// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lockPersonalVault, softLockPersonalVault, type LockFlowState } from '../vault-lock-flow.js';
import { ACCESS_NOT_READY_MESSAGE, VaultAccessProxy } from '../../services/vault/vault-access-proxy.js';

interface FakeFlags {
  unlocked?: boolean;
  open?: boolean;
  softLocked?: boolean;
  opening?: boolean;
  closeFails?: boolean;
}

function fakeState(flags: FakeFlags = {}) {
  const calls: string[] = [];
  let unlocked = flags.unlocked ?? true;
  const watcher = { stop: () => calls.push('watcher.stop') };
  const state = {
    calls,
    personalLockReason: null as string | null,
    currentMasterPassword: 'pw' as string | null,
    vaultWatcher: watcher as unknown,
    vault: {
      isUnlocked: () => unlocked,
      lock: () => {
        calls.push('vault.lock');
        unlocked = false;
      },
      setOnMutation: (cb: unknown) => calls.push(cb === null ? 'vault.setOnMutation(null)' : 'vault.setOnMutation'),
    },
    chatStore: { lock: () => calls.push('chat.lock') },
    cloudSync: { disable: () => calls.push('cloud.disable') },
    localBackup: { disable: () => calls.push('local.disable') },
    appSync: {
      hasSession: () => (flags.open ?? true) || (flags.softLocked ?? false) || (flags.opening ?? false),
      lock: async () => {
        calls.push('appSync.lock');
      },
    },
    closeAllSessions: async () => {
      calls.push('closeAllSessions');
      if (flags.closeFails) throw new Error('rdp stuck');
    },
  };
  return state;
}

const asFlow = (s: ReturnType<typeof fakeState>) => s as unknown as LockFlowState;

describe('soft lock (displaced by another device)', () => {
  it('keeps open sessions, clears the key and backups, and records the reason', () => {
    const s = fakeState();
    softLockPersonalVault(asFlow(s), 'open_elsewhere');
    expect(s.calls).not.toContain('closeAllSessions');
    expect(s.calls).not.toContain('appSync.lock');
    expect(s.calls).toEqual(expect.arrayContaining(['watcher.stop', 'cloud.disable', 'local.disable', 'vault.setOnMutation(null)', 'chat.lock', 'vault.lock']));
    expect(s.currentMasterPassword).toBeNull();
    expect(s.vaultWatcher).toBeNull();
    expect(s.personalLockReason).toBe('open_elsewhere');
  });
});

describe('manual lock', () => {
  it('closes sessions, releases through the sync manager, then locks and clears the reason', async () => {
    const s = fakeState();
    s.personalLockReason = 'open_elsewhere';
    await lockPersonalVault(asFlow(s));
    expect(s.calls[0]).toBe('closeAllSessions');
    expect(s.calls.indexOf('appSync.lock')).toBeLessThan(s.calls.indexOf('vault.lock'));
    expect(s.calls.indexOf('cloud.disable')).toBeLessThan(s.calls.indexOf('appSync.lock'));
    expect(s.personalLockReason).toBeNull();
    expect(s.currentMasterPassword).toBeNull();
  });

  it('also runs for a soft-locked vault (the lease and working copy still need closing)', async () => {
    const s = fakeState({ unlocked: false, open: false, softLocked: true });
    await lockPersonalVault(asFlow(s));
    expect(s.calls).toContain('appSync.lock');
  });

  it('runs while an unlock is still in progress (the sync manager cancels and closes it)', async () => {
    const s = fakeState({ unlocked: false, open: false, softLocked: false, opening: true });
    await lockPersonalVault(asFlow(s));
    expect(s.calls).toEqual(expect.arrayContaining(['closeAllSessions', 'appSync.lock', 'vault.lock']));
  });

  it('does nothing when no personal vault is open', async () => {
    const s = fakeState({ unlocked: false, open: false, softLocked: false });
    await lockPersonalVault(asFlow(s));
    expect(s.calls).toEqual([]);
  });

  it('still locks when closing a session fails', async () => {
    const s = fakeState({ closeFails: true });
    await lockPersonalVault(asFlow(s));
    expect(s.calls).toContain('vault.lock');
    expect(s.calls).toContain('appSync.lock');
  });
});

describe('vault access proxy', () => {
  it('refuses calls before the vault IPC module installs its handlers, then forwards', async () => {
    const proxy = new VaultAccessProxy();
    expect(() => proxy.softLock('open_elsewhere')).toThrow(ACCESS_NOT_READY_MESSAGE);
    const seen: string[] = [];
    proxy.set({
      blockAccess: (r) => void seen.push(`block:${r}`),
      softLock: (r) => void seen.push(`soft:${r}`),
      openPrivateInPlace: async (p) => void seen.push(`open:${p}`),
      createPrivateInPlace: async (p) => void seen.push(`create:${p}`),
    });
    proxy.blockAccess('open_elsewhere');
    proxy.softLock('open_elsewhere');
    await proxy.openPrivateInPlace('/a.conduit', 'pw');
    await proxy.createPrivateInPlace('/b.conduit', 'pw');
    expect(seen).toEqual(['block:open_elsewhere', 'soft:open_elsewhere', 'open:/a.conduit', 'create:/b.conduit']);
  });
});
