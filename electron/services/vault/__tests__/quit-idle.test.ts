// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuitFlush, type QuitFlushDeps } from '../quit-flush.js';
import { IDLE_CHECK_MS, shouldIdleLock, startIdleLock, type IdleLockDeps } from '../idle-lock.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function quitHarness(overrides: Partial<QuitFlushDeps> = {}) {
  let quits = 0;
  let open = true;
  const deps: QuitFlushDeps = {
    needsFlush: () => open,
    flush: async () => {
      open = false;
    },
    quit: () => {
      quits++;
    },
    capMs: 7000,
    ...overrides,
  };
  const flush = createQuitFlush(deps);
  const hook = (e: { preventDefault(): void }) => flush.beforeQuit(e);
  const event = () => {
    let prevented = false;
    return { preventDefault: () => (prevented = true), prevented: () => prevented };
  };
  return {
    hook,
    flushNow: () => flush.flushNow(),
    reset: () => flush.reset(),
    reopen: () => {
      open = true;
    },
    event,
    quits: () => quits,
  };
}

describe('quit flush before an update install', () => {
  it('flushes without quitting; the quit that follows passes at once', async () => {
    const h = quitHarness();
    await expect(h.flushNow()).resolves.toBe(true);
    expect(h.quits()).toBe(0);
    const e = h.event();
    expect(h.hook(e)).toBe(false);
    expect(e.prevented()).toBe(false);
  });

  it('after a failed install, a vault unlocked again is flushed on the next quit', async () => {
    let flushes = 0;
    const h = quitHarness();
    const counted = quitHarness({
      flush: async () => {
        flushes++;
      },
    });
    await expect(counted.flushNow()).resolves.toBe(true);
    counted.reset();
    counted.reopen();
    const e = counted.event();
    expect(counted.hook(e)).toBe(true);
    expect(e.prevented()).toBe(true);
    await vi.runAllTimersAsync();
    expect(flushes).toBe(2);
    expect(counted.quits()).toBe(1);

    await h.flushNow();
    h.reopen();
    expect(h.hook(h.event())).toBe(false);
  });

  it('is bounded by the same cap', async () => {
    const h = quitHarness({ flush: () => new Promise<void>(() => undefined) });
    let settled = false;
    void h.flushNow().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(6999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(h.quits()).toBe(0);
  });

  it('a quit during it waits for it and quits once it ends; nothing to flush resolves false', async () => {
    const h = quitHarness({ flush: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)) });
    const flushing = h.flushNow();
    const e = h.event();
    expect(h.hook(e)).toBe(true);
    expect(e.prevented()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await flushing;
    expect(h.quits()).toBe(1);

    const idle = quitHarness({ needsFlush: () => false });
    await expect(idle.flushNow()).resolves.toBe(false);
  });
});

describe('quit flush', () => {
  it('passes through when no personal vault is open', () => {
    const h = quitHarness({ needsFlush: () => false });
    const e = h.event();
    expect(h.hook(e)).toBe(false);
    expect(e.prevented()).toBe(false);
  });

  it('defers the first quit, flushes, then quits again and lets the second quit through', async () => {
    const h = quitHarness();
    const e = h.event();
    expect(h.hook(e)).toBe(true);
    expect(e.prevented()).toBe(true);
    await vi.runAllTimersAsync();
    expect(h.quits()).toBe(1);
    const second = h.event();
    expect(h.hook(second)).toBe(false);
    expect(second.prevented()).toBe(false);
  });

  it('is bounded: a flush that never finishes still quits at the cap', async () => {
    const h = quitHarness({ flush: () => new Promise<void>(() => undefined) });
    expect(h.hook(h.event())).toBe(true);
    await vi.advanceTimersByTimeAsync(6999);
    expect(h.quits()).toBe(0);
    const again = h.event();
    expect(h.hook(again)).toBe(true);
    expect(again.prevented()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.quits()).toBe(1);
  });

  it('quits even when the flush fails or the check throws', async () => {
    const failing = quitHarness({ flush: async () => Promise.reject(new Error('boom')) });
    failing.hook(failing.event());
    await vi.runAllTimersAsync();
    expect(failing.quits()).toBe(1);

    const broken = quitHarness({
      needsFlush: () => {
        throw new Error('not ready');
      },
    });
    expect(broken.hook(broken.event())).toBe(false);
  });
});

function idleDeps(overrides: Partial<IdleLockDeps> = {}) {
  const locks: string[] = [];
  let lockScreen: (() => void) | null = null;
  let unsubscribed = false;
  const deps: IdleLockDeps = {
    minutes: () => 5,
    idleSeconds: () => 0,
    canLock: () => true,
    lock: async () => {
      locks.push('lock');
    },
    onLockScreen: (l) => {
      lockScreen = l;
      return () => {
        unsubscribed = true;
      };
    },
    ...overrides,
  };
  return { deps, locks, fireLockScreen: () => lockScreen?.(), unsubscribed: () => unsubscribed };
}

describe('idle auto-lock', () => {
  it('decides from the setting, the vault state and the idle time', () => {
    const base = { minutes: () => 5, idleSeconds: () => 300, canLock: () => true };
    expect(shouldIdleLock(base, 'idle')).toBe(true);
    expect(shouldIdleLock({ ...base, idleSeconds: () => 299 }, 'idle')).toBe(false);
    expect(shouldIdleLock({ ...base, minutes: () => 0 }, 'idle')).toBe(false);
    expect(shouldIdleLock({ ...base, minutes: () => 0 }, 'lock-screen')).toBe(false);
    expect(shouldIdleLock({ ...base, canLock: () => false }, 'idle')).toBe(false);
    expect(shouldIdleLock({ ...base, idleSeconds: () => 0 }, 'lock-screen')).toBe(true);
    expect(
      shouldIdleLock(
        {
          ...base,
          minutes: () => {
            throw new Error('settings');
          },
        },
        'idle',
      ),
    ).toBe(false);
  });

  it('checks on an interval and on screen lock, and stops cleanly', async () => {
    let idle = 0;
    const h = idleDeps({ idleSeconds: () => idle });
    const stop = startIdleLock(h.deps);
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
    expect(h.locks).toEqual([]);
    idle = 5 * 60;
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS);
    expect(h.locks).toEqual(['lock']);
    h.fireLockScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.locks).toEqual(['lock', 'lock']);
    stop();
    expect(h.unsubscribed()).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS * 3);
    expect(h.locks).toHaveLength(2);
  });

  it('stays off by default (0 minutes)', async () => {
    const h = idleDeps({ minutes: () => 0, idleSeconds: () => 99_999 });
    const stop = startIdleLock(h.deps);
    await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS * 2);
    h.fireLockScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.locks).toEqual([]);
    stop();
  });
});
