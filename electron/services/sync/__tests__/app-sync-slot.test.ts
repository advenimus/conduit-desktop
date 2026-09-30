// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OPEN_CANCELLED_MESSAGE } from '../../vault-session/open-errors.js';
import { OPEN_IN_PROGRESS_MESSAGE, VAULT_ALREADY_OPEN_MESSAGE, VaultSlot } from '../app-sync-slot.js';
import { MemoryLogger, flushAsync } from './host-fakes.js';

class FakeRuntime {
  readonly calls: string[] = [];
  soft = false;
  gate: Promise<void> = Promise.resolve();

  isSoftLocked(): boolean {
    return this.soft;
  }

  async lock(): Promise<void> {
    this.calls.push('lock:start');
    await this.gate;
    this.calls.push('lock:end');
  }

  async quit(): Promise<void> {
    this.calls.push('quit');
  }
}

interface Item {
  readonly name: string;
  readonly runtime: FakeRuntime;
}

function item(name: string): Item {
  return { name, runtime: new FakeRuntime() };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('VaultSlot (spec 6.3, 6.4)', () => {
  it('a lock during an open cancels its waits, closes the result and fails the open', async () => {
    const slot = new VaultSlot<Item>(new MemoryLogger());
    const opened = item('A');
    const done = deferred<Item>();
    let cancelled = false;
    const open = slot.open(async () => {
      void slot.cancelRequested().then(() => (cancelled = true));
      return done.promise;
    });
    const openResult = open.catch((e: Error) => e);
    await flushAsync();
    expect(slot.isOpening()).toBe(true);
    expect(slot.isBusy()).toBe(true);

    let locked = false;
    const lock = slot.close('lock').then(() => (locked = true));
    await flushAsync();
    expect(cancelled).toBe(true);
    expect(locked).toBe(false);

    done.resolve(opened);
    await lock;
    expect(((await openResult) as Error).message).toBe(OPEN_CANCELLED_MESSAGE);
    expect(opened.runtime.calls).toEqual(['lock:start', 'lock:end']);
    expect(slot.current()).toBeNull();
    expect(slot.isBusy()).toBe(false);
  });

  it('allows one open at a time and refuses a second vault while one is open', async () => {
    const slot = new VaultSlot<Item>(new MemoryLogger());
    const done = deferred<Item>();
    const first = slot.open(() => done.promise);
    await expect(slot.open(async () => item('B'))).rejects.toThrow(OPEN_IN_PROGRESS_MESSAGE);
    done.resolve(item('A'));
    await first;
    await expect(slot.open(async () => item('B'))).rejects.toThrow(VAULT_ALREADY_OPEN_MESSAGE);
    expect(slot.current()?.name).toBe('A');
  });

  it('shares one close between concurrent locks, and a new open waits for it', async () => {
    const slot = new VaultSlot<Item>(new MemoryLogger());
    const a = item('A');
    const gate = deferred<void>();
    a.runtime.gate = gate.promise;
    await slot.open(async () => a);

    const lock1 = slot.close('lock');
    const lock2 = slot.close('lock');
    expect(slot.isBusy()).toBe(true);
    let reopened = false;
    const reopen = slot.open(async () => item('B')).then(() => (reopened = true));
    await flushAsync();
    expect(reopened).toBe(false);

    gate.resolve();
    await Promise.all([lock1, lock2, reopen]);
    expect(a.runtime.calls).toEqual(['lock:start', 'lock:end']);
    expect(slot.current()?.name).toBe('B');
  });

  it('keeps the soft-locked vault when a re-open fails, and replaces it when one succeeds', async () => {
    const slot = new VaultSlot<Item>(new MemoryLogger());
    const displaced = item('A');
    await slot.open(async () => displaced);
    displaced.runtime.soft = true;

    await expect(slot.open(async () => Promise.reject(new Error('Invalid master password')))).rejects.toThrow('Invalid master password');
    expect(slot.current()?.name).toBe('A');
    expect(slot.isBusy()).toBe(true);

    await slot.open(async () => item('B'));
    expect(slot.current()?.name).toBe('B');
  });

  it('a quit during an open closes the result with quit', async () => {
    const slot = new VaultSlot<Item>(new MemoryLogger());
    const opened = item('A');
    const done = deferred<Item>();
    const open = slot.open(() => done.promise).catch((e: Error) => e);
    const quit = slot.close('quit');
    done.resolve(opened);
    await quit;
    expect(((await open) as Error).message).toBe(OPEN_CANCELLED_MESSAGE);
    expect(opened.runtime.calls).toEqual(['quit']);
  });
});
