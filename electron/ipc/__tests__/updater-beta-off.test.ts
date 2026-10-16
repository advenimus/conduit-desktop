// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';

type Handler = (event: unknown, args?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const send = vi.fn();
const appEmit = vi.fn();
const settings: { beta_updates?: boolean } = {};

const BETA = '0.19.0-beta.1';

interface CheckResult {
  isUpdateAvailable: boolean;
  updateInfo: { version: string; releaseNotes?: string; releaseDate?: string };
  cancellationToken?: { cancel: () => void };
  downloadPromise?: Promise<unknown> | null;
}

class FakeUpdater extends EventEmitter {
  autoInstallOnAppQuit = false;
  autoDownload = false;
  forceDevUpdateConfig = false;
  allowPrerelease = false;
  allowDowngrade = false;
  check: () => Promise<CheckResult | null> = async () => null;
  checkForUpdates = vi.fn(() => this.check());
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

let fake = new FakeUpdater();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  app: { getVersion: () => '0.18.1', emit: (...args: unknown[]) => appEmit(...args), quit: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return fake;
  },
  default: {},
}));
vi.mock('../settings.js', () => ({
  readSettings: () => ({ ...settings }),
  writeSettings: (next: { beta_updates?: boolean }) => {
    settings.beta_updates = next.beta_updates;
  },
}));
vi.mock('../../services/state.js', () => ({
  AppState: { getInstance: () => ({ getMainWindow: () => ({ webContents: { send } }) }) },
}));
vi.mock('../../services/env-config.js', () => ({ getEnvConfig: () => ({ websiteUrl: 'https://example.test' }) }));
vi.mock('../../services/app-lifecycle.js', () => ({ setIsQuitting: vi.fn() }));
vi.mock('../../services/vault/app-quit-flush.js', () => ({ appQuitFlush: () => ({ flushNow: vi.fn(), reset: vi.fn() }) }));
vi.mock('../update-install.js', () => ({ installAfterVaultFlush: vi.fn(async () => undefined) }));

type UpdaterModule = typeof import('../updater.js');
let mod: UpdaterModule;

function betaFound(token = { cancel: vi.fn() }, download: Promise<unknown> = new Promise(() => {})) {
  return async (): Promise<CheckResult> => {
    fake.emit('update-available', { version: BETA, releaseNotes: 'notes' });
    return { isUpdateAvailable: true, updateInfo: { version: BETA }, cancellationToken: token, downloadPromise: download };
  };
}

const nothingFound = async (): Promise<CheckResult> => ({ isUpdateAvailable: false, updateInfo: { version: '0.18.1' } });

function call(channel: string, args?: unknown) {
  return handlers.get(channel)!(null, args);
}

function sentChannels(): string[] {
  return send.mock.calls.map((c) => c[0] as string);
}

beforeEach(async () => {
  silenceConsole();
  vi.resetModules();
  handlers.clear();
  send.mockReset();
  appEmit.mockReset();
  delete settings.beta_updates;
  fake = new FakeUpdater();
  mod = await import('../updater.js');
  mod.registerUpdaterHandlers();
});

afterEach(() => {
  mod.stopPeriodicUpdateChecks();
});

describe('turning beta updates off with a beta pending', () => {
  it('stops a downloaded beta from installing on quit and clears the menu and overlay', async () => {
    settings.beta_updates = true;
    fake.check = betaFound(undefined, Promise.resolve());
    await mod.setupAutoUpdater();
    fake.emit('update-downloaded', { version: BETA });
    expect(mod.downloadedVersion).toBe(BETA);
    expect(fake.autoInstallOnAppQuit).toBe(true);

    appEmit.mockClear();
    fake.check = nothingFound;
    await call('updater_set_beta_updates', { enabled: false });

    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(mod.downloadedVersion).toBeNull();
    expect(sentChannels()).toContain('update:cleared');
    expect(appEmit).toHaveBeenCalledWith('conduit:update-downloaded');
    expect(await call('check_for_updates')).toBeNull();
    await expect(call('install_update')).rejects.toThrow();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('cancels a beta download that is still running', async () => {
    settings.beta_updates = true;
    const token = { cancel: vi.fn() };
    fake.check = betaFound(token);
    await mod.setupAutoUpdater();

    fake.check = nothingFound;
    await call('updater_set_beta_updates', { enabled: false });

    expect(token.cancel).toHaveBeenCalledTimes(1);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(sentChannels()).toContain('update:cleared');
    await expect(call('download_and_install_update')).rejects.toThrow('Beta updates are off');
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
  });

  it('turns install on quit off before the platform updater reads it when a beta lands after the switch', async () => {
    settings.beta_updates = true;
    fake.check = betaFound();
    await mod.setupAutoUpdater();
    fake.check = nothingFound;
    await call('updater_set_beta_updates', { enabled: false });

    let seenByPlatform: boolean | null = null;
    fake.on('update-downloaded', () => {
      seenByPlatform = fake.autoInstallOnAppQuit;
    });
    send.mockClear();
    fake.emit('update-downloaded', { version: BETA });

    expect(seenByPlatform).toBe(false);
    expect(mod.downloadedVersion).toBeNull();
    expect(sentChannels()).not.toContain('update:downloaded');
  });

  it('cancels a beta found by a check that started before betas were turned back off', async () => {
    await mod.setupAutoUpdater();
    let finishCheck: () => void = () => {};
    const token = { cancel: vi.fn() };
    fake.check = () =>
      new Promise<CheckResult>((resolve) => {
        finishCheck = () => resolve(betaFound(token)());
      });

    const turnOn = call('updater_set_beta_updates', { enabled: true });
    await vi.waitFor(() => expect(fake.checkForUpdates).toHaveBeenCalledTimes(2));
    const turnOff = call('updater_set_beta_updates', { enabled: false });
    fake.check = nothingFound;
    send.mockClear();
    finishCheck();
    await Promise.all([turnOn, turnOff]);

    expect(token.cancel).toHaveBeenCalledTimes(1);
    expect(sentChannels()).not.toContain('update:available');
    expect(await call('check_for_updates')).toBeNull();
    expect(fake.allowPrerelease).toBe(false);
  });

  it('keeps a regular update when beta updates are turned off', async () => {
    settings.beta_updates = true;
    fake.check = async () => {
      fake.emit('update-available', { version: '0.18.2' });
      return { isUpdateAvailable: true, updateInfo: { version: '0.18.2' }, cancellationToken: { cancel: vi.fn() }, downloadPromise: Promise.resolve() };
    };
    await mod.setupAutoUpdater();
    fake.emit('update-downloaded', { version: '0.18.2' });

    await call('updater_set_beta_updates', { enabled: false });

    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(mod.downloadedVersion).toBe('0.18.2');
    expect(sentChannels()).not.toContain('update:cleared');
  });
});
