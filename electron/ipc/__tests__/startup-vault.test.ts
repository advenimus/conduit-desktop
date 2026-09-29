// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

type Handler = (event: unknown, args?: unknown) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-vault-'));
const WORK = path.join(tmp, 'Work.conduit');
fs.writeFileSync(WORK, 'x');

const world = {
  settings: {} as Record<string, unknown>,
  entries: new Map<string, { password: string; userId: string | null }>(),
  opened: [] as { source: string; password: string }[],
  lineage: 'L1' as string | null,
  user: 'user-a' as string | null,
};

vi.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: Handler) => handlers.set(c, fn) } }));
vi.mock('../settings.js', () => ({
  readSettings: () => ({ last_vault_type: null, ...world.settings }),
  writeSettings: (s: Record<string, unknown>) => {
    world.settings = s;
  },
  updateRecentVaults: () => undefined,
}));
vi.mock('../../services/vault/auto-unlock-electron.js', () => ({
  getAutoUnlockStore: () => ({
    status: () => ({ usable: true, reason: 'ok', backend: 'keychain', storeName: 'system keychain' }),
    dir: () => tmp,
    sealPassword: async (l: string, userId: string | null, password: string) => {
      world.entries.clear();
      world.entries.set(l, { password, userId });
      return { ok: true };
    },
    readPassword: (l: string) => {
      const e = world.entries.get(l);
      return e ? { kind: 'ok', ...e } : { kind: 'missing' };
    },
    hasEntry: (l: string) => world.entries.has(l),
    removeEntry: (l: string) => world.entries.delete(l),
    removeAll: () => {
      const n = world.entries.size;
      world.entries.clear();
      return n;
    },
    removeAllExcept: (l: string | null) => {
      let n = 0;
      for (const k of [...world.entries.keys()]) if (k !== l) n += world.entries.delete(k) ? 1 : 0;
      return n;
    },
  }),
}));
vi.mock('../../services/vault/biometric.js', () => ({ getBiometricService: () => ({ authenticate: async () => false }) }));
vi.mock('../biometric-lineage.js', () => ({ isBiometricEnabledForPath: async () => false }));

const fakeState = {
  currentVaultPath: path.join(tmp, 'default.conduit'),
  currentMasterPassword: null as string | null,
  vault: { isUnlocked: () => fakeState.currentMasterPassword !== null },
  teamVaultManager: { getActiveVault: () => null },
  appSync: { lineageForPath: async () => world.lineage, currentLineageId: () => world.lineage },
  authService: {
    hasInitialized: () => true,
    getAuthState: () => ({ user: world.user === null ? null : { id: world.user } }),
    onInitialized: () => undefined,
    onStateChange: () => undefined,
  },
  switchVault: (p: string) => {
    fakeState.currentVaultPath = p;
  },
  getMainWindow: () => null,
};
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: () => fakeState } }));

const events = await import('../vault-events.js');
vi.mock('../vault-unlock.js', () => ({
  openPersonalAndFinish: async (_s: unknown, req: { source: string; password: string; path: string }) => {
    world.opened.push({ source: req.source, password: req.password });
    fakeState.currentMasterPassword = req.password;
    events.emitPersonalUnlocked({ source: req.source as never, lineageId: 'L1' });
    return { lineageId: 'L1', shared: true, engine: true };
  },
}));
vi.mock('../vault-lock-flow.js', () => ({
  lockPersonalVault: async (_s: unknown, cause: 'window-close' | 'other' = 'other') => {
    if (fakeState.currentMasterPassword === null) return false;
    fakeState.currentMasterPassword = null;
    events.emitPersonalLocked({ cause });
    return true;
  },
}));

const sv = await import('../startup-vault.js');
const { isMcpHeld, releaseMcpHold } = await import('../../ipc-server/mcp-hold.js');

class FakeWindow extends EventEmitter {
  readonly sent: string[] = [];
  readonly webContents = Object.assign(new EventEmitter(), { send: (c: string) => this.sent.push(c) });
  isDestroyed() {
    return false;
  }
}

const call = (channel: string, args?: unknown) => handlers.get(channel)!(null, args);
const win = new FakeWindow();

beforeAll(() => {
  sv.initStartupVault({ switchSet: false });
  sv.registerStartupVaultHandlers();
  sv.attachStartupWindow(win as never);
  win.emit('show');
});

beforeEach(() => {
  silenceConsole();
  world.settings = { startup_vault: { kind: 'personal', path: WORK, lineageId: 'L1' } };
  world.entries.clear();
  world.entries.set('L1', { password: 'saved', userId: 'user-a' });
  world.opened = [];
  releaseMcpHold('test');
});

describe('startup vault runtime (docs/AUTO_UNLOCK.md 4.2 to 4.8)', () => {
  it('plans once, unlocks automatically, holds MCP until a key press, and re-arms after a close', async () => {
    expect(await call('vault_startup_plan')).toEqual({ kind: 'personal', path: WORK, name: 'Work', auto: true });
    expect(await call('vault_startup_plan')).toEqual({ kind: 'none' });
    expect(await call('vault_auto_unlock', {})).toEqual({ ok: true });
    expect(world.opened).toEqual([{ source: 'auto_unlock', password: 'saved' }]);
    expect(isMcpHeld()).toBe(true);
    win.webContents.emit('before-input-event', {}, { type: 'keyDown', shift: false, alt: false });
    expect(isMcpHeld()).toBe(false);
    expect((await call('auto_unlock_status')) as { currentOn: boolean }).toMatchObject({ currentOn: true, savedPath: WORK });

    const { lockPersonalVault } = await import('../vault-lock-flow.js');
    await lockPersonalVault(fakeState as never, 'window-close');
    win.emit('show');
    expect(win.sent).toEqual([sv.STARTUP_AGAIN_EVENT]);
    expect(await call('vault_startup_plan')).toMatchObject({ kind: 'personal', auto: true });
    expect(await call('vault_auto_unlock', {})).toEqual({ ok: true });

    await lockPersonalVault(fakeState as never, 'other');
    await lockPersonalVault(fakeState as never, 'window-close');
    win.emit('show');
    expect(win.sent).toHaveLength(1);
    expect(await call('vault_startup_plan')).toEqual({ kind: 'none' });
  });

  it('a typed unlock records the proof the checkbox needs, once, and never holds MCP', async () => {
    fakeState.currentVaultPath = WORK;
    const { openPersonalAndFinish } = await import('../vault-unlock.js');
    await openPersonalAndFinish(fakeState as never, { path: WORK, password: 'typed', source: 'vault_unlock' });
    expect(isMcpHeld()).toBe(false);
    world.entries.clear();
    expect(await call('auto_unlock_enable', { proof: { kind: 'recent-unlock' } })).toMatchObject({ currentOn: true });
    expect(world.entries.get('L1')).toEqual({ password: 'typed', userId: 'user-a' });
    await expect(call('auto_unlock_enable', { proof: { kind: 'recent-unlock' } })).rejects.toThrow('Unlock the vault again');
  });

  it('choosing another startup vault forgets the saved unlock; turning off keeps the choice', async () => {
    const res = (await call('startup_vault_set', { kind: 'hub' })) as { forgot: boolean };
    expect(res.forgot).toBe(true);
    expect(world.settings.startup_vault).toEqual({ kind: 'hub' });
    world.settings = { startup_vault: { kind: 'personal', path: WORK, lineageId: 'L1' } };
    world.entries.set('L1', { password: 'p', userId: null });
    expect((await call('startup_vault_set', { kind: 'personal', path: WORK })) as { forgot: boolean }).toMatchObject({ forgot: false });
    await call('auto_unlock_disable');
    expect(world.entries.size).toBe(0);
    expect(world.settings.startup_vault).toMatchObject({ kind: 'personal', path: WORK });
    await expect(call('startup_vault_set', { kind: 'personal', path: 'relative.conduit' })).rejects.toThrow();
  });

  it('a pointer report releases the hold at once', async () => {
    const { holdMcpUntilInput } = await import('../../ipc-server/mcp-hold.js');
    holdMcpUntilInput();
    await call('startup_user_present', { kind: 'pointer' });
    expect(isMcpHeld()).toBe(false);
  });
});
