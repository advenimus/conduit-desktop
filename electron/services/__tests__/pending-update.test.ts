// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPendingUpdateGate } from '../pending-update.js';

const BETA = '0.19.0-beta.1';
const REGULAR = '0.19.0';

function setup(betaOn: boolean) {
  const updater = { autoInstallOnAppQuit: true };
  const beta = { on: betaOn };
  const gate = createPendingUpdateGate(updater, () => beta.on);
  const token = { cancel: vi.fn() };
  return { updater, beta, gate, token };
}

describe('pending update gate', () => {
  it('lets a regular update install on quit', () => {
    const { updater, gate, token } = setup(false);
    expect(gate.offer(REGULAR)).toBe(true);
    gate.track(REGULAR, token, Promise.resolve());
    expect(gate.downloaded(REGULAR)).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(gate.downloadedVersion).toBe(REGULAR);
    expect(gate.canInstall()).toBe(true);
    expect(token.cancel).not.toHaveBeenCalled();
  });

  it('lets a beta install on quit while betas are on', () => {
    const { updater, gate, token } = setup(true);
    expect(gate.offer(BETA)).toBe(true);
    gate.track(BETA, token, Promise.resolve());
    expect(gate.downloaded(BETA)).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(gate.canInstall()).toBe(true);
  });

  it('cancels a beta download in flight when betas are turned off', () => {
    const { updater, beta, gate, token } = setup(true);
    gate.offer(BETA);
    gate.track(BETA, token, new Promise(() => {}));
    beta.on = false;
    expect(gate.clearIfBlocked()).toBe(true);
    expect(token.cancel).toHaveBeenCalledTimes(1);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(gate.progressVisible()).toBe(false);
  });

  it('does not install a beta that finishes downloading after betas were turned off', () => {
    const { updater, beta, gate, token } = setup(true);
    gate.offer(BETA);
    gate.track(BETA, token, new Promise(() => {}));
    beta.on = false;
    expect(gate.downloaded(BETA)).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(gate.downloadedVersion).toBeNull();
    expect(gate.canInstall()).toBe(false);
  });

  it('drops a downloaded beta when betas are turned off', () => {
    const { updater, beta, gate, token } = setup(true);
    gate.offer(BETA);
    gate.track(BETA, token, Promise.resolve());
    gate.downloaded(BETA);
    beta.on = false;
    expect(gate.clearIfBlocked()).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(gate.downloadedVersion).toBeNull();
    expect(gate.canInstall()).toBe(false);
    expect(gate.isBlocked(gate.offeredVersion)).toBe(true);
  });

  it('turns install on quit back on once a regular update downloads', () => {
    const { updater, beta, gate, token } = setup(true);
    gate.offer(BETA);
    gate.track(BETA, token, Promise.resolve());
    gate.downloaded(BETA);
    beta.on = false;
    gate.clearIfBlocked();
    expect(gate.offer(REGULAR)).toBe(true);
    gate.track(REGULAR, { cancel: vi.fn() }, Promise.resolve());
    expect(gate.downloaded(REGULAR)).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(gate.downloadedVersion).toBe(REGULAR);
  });

  it('cancels a beta found by a check that ran before betas were turned back off', () => {
    const { updater, beta, gate, token } = setup(true);
    beta.on = false;
    expect(gate.offer(BETA)).toBe(false);
    expect(gate.track(BETA, token, new Promise(() => {}))).toBe(true);
    expect(token.cancel).toHaveBeenCalledTimes(1);
    expect(gate.progressVisible()).toBe(false);
    expect(gate.downloaded(BETA)).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('forgets an earlier download when a blocked beta is cancelled, since electron-updater clears its cache', () => {
    const { updater, beta, gate, token } = setup(true);
    gate.offer('0.18.2');
    gate.track('0.18.2', { cancel: vi.fn() }, Promise.resolve());
    gate.downloaded('0.18.2');
    gate.offer(BETA);
    beta.on = false;
    expect(gate.track(BETA, token, new Promise(() => {}))).toBe(true);
    expect(gate.downloadedVersion).toBeNull();
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('reports nothing blocked when tracking a regular download', () => {
    const { gate, token } = setup(false);
    gate.offer(REGULAR);
    expect(gate.track(REGULAR, token, Promise.resolve())).toBe(false);
  });

  it('leaves a regular update alone when betas are turned off', () => {
    const { updater, gate, token } = setup(true);
    gate.offer(REGULAR);
    gate.track(REGULAR, token, Promise.resolve());
    gate.downloaded(REGULAR);
    expect(gate.clearIfBlocked()).toBe(false);
    expect(token.cancel).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(gate.downloadedVersion).toBe(REGULAR);
  });

  it('refuses to install a downloaded beta once betas are off, even before clearing', () => {
    const { beta, gate, token } = setup(true);
    gate.offer(BETA);
    gate.track(BETA, token, Promise.resolve());
    gate.downloaded(BETA);
    beta.on = false;
    expect(gate.canInstall()).toBe(false);
  });

  it('swallows a cancelled download so it is not an unhandled rejection', async () => {
    const { beta, gate, token } = setup(true);
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      gate.offer(BETA);
      beta.on = false;
      gate.track(BETA, token, Promise.reject(new Error('cancelled')));
      await new Promise((r) => setTimeout(r, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
