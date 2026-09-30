// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { installAfterVaultFlush, type UpdateInstallDeps } from '../update-install.js';

function deps(over: Partial<UpdateInstallDeps> = {}) {
  const order: string[] = [];
  const failed: boolean[] = [];
  const d: UpdateInstallDeps = {
    flushVault: async () => {
      order.push('flush');
      return true;
    },
    quitAndInstall: () => {
      order.push('install');
    },
    scheduleForceQuit: () => {
      order.push('force-quit timer');
    },
    onFailed: (flushed) => {
      failed.push(flushed);
    },
    ...over,
  };
  return { d, order, failed };
}

describe('installing a downloaded update', () => {
  it('flushes the personal vault before the installer starts', async () => {
    const h = deps();
    await installAfterVaultFlush(h.d);
    expect(h.order).toEqual(['flush', 'install', 'force-quit timer']);
    expect(h.failed).toEqual([]);
  });

  it('waits for a slow flush', async () => {
    let finish: (v: boolean) => void = () => undefined;
    const install = vi.fn();
    const h = deps({ flushVault: () => new Promise<boolean>((resolve) => (finish = resolve)), quitAndInstall: install });
    const done = installAfterVaultFlush(h.d);
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();
    finish(false);
    await done;
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('reports a failed install, saying whether the vault was closed for it', async () => {
    const h = deps({
      quitAndInstall: () => {
        throw new Error('no installer');
      },
    });
    await installAfterVaultFlush(h.d);
    expect(h.failed).toEqual([true]);
    expect(h.order).toEqual(['flush']);
  });
});
