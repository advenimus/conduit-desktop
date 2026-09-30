// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { followSharedPath, type SharedPathChange } from '../app-sync-binding.js';
import type { FileBinding } from '../types.js';
import type { SyncLogger } from '../host.js';

function fakeBinding() {
  const listeners = new Set<(b: FileBinding) => void>();
  return {
    onChange(listener: (b: FileBinding) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    move(sharedPath: string) {
      for (const l of [...listeners]) l({ sharedPath, realpath: sharedPath, fileId: 'f' });
    },
    count: () => listeners.size,
  };
}

function logger(): SyncLogger & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  return { errors, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => errors.push(a) } as unknown as SyncLogger & { errors: unknown[][] };
}

const OLD = path.resolve('/cloud/Vault.conduit');
const NEW = path.resolve('/cloud/Renamed.conduit');

describe('followSharedPath (spec 5.9: the app follows a rebind, Locate or rename)', () => {
  it('reports the move from the current path to the new one', () => {
    const b = fakeBinding();
    let current: string | null = OLD;
    const moves: SharedPathChange[] = [];
    followSharedPath(b, () => current, (c) => {
      moves.push(c);
      current = c.to;
    }, logger());
    b.move(NEW);
    expect(moves).toEqual([{ from: OLD, to: NEW }]);
    b.move(OLD);
    expect(moves).toEqual([{ from: OLD, to: NEW }, { from: NEW, to: OLD }]);
  });

  it('ignores binding changes that keep the path (a file_id adopted or minted)', () => {
    const b = fakeBinding();
    const moved = vi.fn();
    followSharedPath(b, () => OLD, moved, logger());
    b.move(OLD);
    b.move(`${path.dirname(OLD)}/./Vault.conduit`);
    expect(moved).not.toHaveBeenCalled();
  });

  it('ignores a binding of a vault that is no longer the open one', () => {
    const b = fakeBinding();
    const moved = vi.fn();
    followSharedPath(b, () => null, moved, logger());
    b.move(NEW);
    expect(moved).not.toHaveBeenCalled();
  });

  it('logs a failing follower instead of throwing into the engine, and can be stopped', () => {
    const b = fakeBinding();
    const log = logger();
    const stop = followSharedPath(b, () => OLD, () => {
      throw new Error('settings.json is read-only');
    }, log);
    expect(() => b.move(NEW)).not.toThrow();
    expect(log.errors).toHaveLength(1);
    stop();
    expect(b.count()).toBe(0);
  });
});
