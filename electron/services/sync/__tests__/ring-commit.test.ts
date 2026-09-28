// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { commitUnderRing } from '../ring-commit.js';
import type { KeyRing, SyncState } from '../types.js';

function ringWith(tag: string): KeyRing {
  return { current: { epochId: tag, kEpoch: Buffer.from(tag) } } as unknown as KeyRing;
}

function fakeReplica(commitError: Error | null) {
  let ring = ringWith('old');
  let key: Buffer = Buffer.from('old');
  return {
    ring: () => ring,
    setRing(next: KeyRing, k: Buffer) {
      ring = next;
      key = k;
    },
    commit: () => {
      if (commitError !== null) throw commitError;
      return { changedRows: [] } as never;
    },
    key: () => key.toString(),
  };
}

describe('commitUnderRing', () => {
  it('keeps the new ring and key after a commit', () => {
    const r = fakeReplica(null);
    commitUnderRing(r, ringWith('new'), Buffer.from('new'), {} as SyncState);
    expect(r.ring().current.epochId).toBe('new');
    expect(r.key()).toBe('new');
  });

  it('puts the previous ring and key back when the commit fails (disk full)', () => {
    const r = fakeReplica(new Error('SQLITE_FULL'));
    expect(() => commitUnderRing(r, ringWith('new'), Buffer.from('new'), {} as SyncState)).toThrow('SQLITE_FULL');
    expect(r.ring().current.epochId).toBe('old');
    expect(r.key()).toBe('old');
  });
});
