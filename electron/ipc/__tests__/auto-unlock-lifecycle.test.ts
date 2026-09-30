// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from './sync-fakes.js';
import {
  afterOwnCopy,
  afterRelease,
  forgetAll,
  resealAfterPasswordChange,
  savedUnlockForCurrent,
  watchAccountChange,
  type AutoUnlockEvent,
  type LifecycleDeps,
} from '../auto-unlock-lifecycle.js';
import type { AutoUnlockStore, SealResult } from '../../services/vault/auto-unlock-store.js';
import type { StartupVault } from '../startup-vault-core.js';

const WORK = '/v/Work.conduit';

function fakeStore(): AutoUnlockStore & { entries: Map<string, { password: string; userId: string | null }>; sealResult: SealResult } {
  const entries = new Map<string, { password: string; userId: string | null }>();
  const s = {
    entries,
    sealResult: { ok: true } as SealResult,
    status: () => ({ usable: true, reason: 'ok' as const, backend: 'keychain', storeName: 'system keychain' }),
    dir: () => '/x',
    sealPassword: async (lineageId: string, userId: string | null, password: string) => {
      if (!s.sealResult.ok) {
        entries.clear();
        return s.sealResult;
      }
      entries.clear();
      entries.set(lineageId, { password, userId });
      return s.sealResult;
    },
    readPassword: () => ({ kind: 'missing' as const }),
    hasEntry: (l: string) => entries.has(l),
    removeEntry: (l: string) => entries.delete(l),
    removeAll: () => {
      const n = entries.size;
      entries.clear();
      return n;
    },
    removeAllExcept: () => 0,
  };
  return s;
}

let store: ReturnType<typeof fakeStore>;
let startup: StartupVault | null;
let events: AutoUnlockEvent[];
let user: string | null;
let lineage: string | null;

function deps(): LifecycleDeps {
  return {
    store,
    readStartup: () => startup,
    writeStartup: (next) => {
      startup = next;
    },
    notify: (e) => events.push(e),
    lineageForPath: async () => lineage,
    currentLineageId: () => 'L-open',
    currentPath: () => WORK,
    userId: () => user,
  };
}

beforeEach(() => {
  silenceConsole();
  store = fakeStore();
  startup = { kind: 'personal', path: WORK, lineageId: 'L1' };
  events = [];
  user = 'user-a';
  lineage = 'L1';
});

describe('re-seal after a password change (spec 3.6)', () => {
  it('seals the new password under the current lineage and moves the startup lineage', async () => {
    store.entries.set('L1', { password: 'old', userId: 'user-a' });
    expect(savedUnlockForCurrent(deps())).toBe(true);
    lineage = 'L2';
    await resealAfterPasswordChange(deps(), true, 'new');
    expect([...store.entries]).toEqual([['L2', { password: 'new', userId: 'user-a' }]]);
    expect(startup).toEqual({ kind: 'personal', path: WORK, lineageId: 'L2' });
    expect(events).toEqual([{ kind: 'resealed', name: 'Work' }]);
  });

  it('does nothing when it was off before', async () => {
    await resealAfterPasswordChange(deps(), false, 'new');
    expect(store.entries.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('a refused seal forgets the old entry and says so', async () => {
    store.entries.set('L1', { password: 'old', userId: 'user-a' });
    store.sealResult = { ok: false, reason: 'weak' };
    await resealAfterPasswordChange(deps(), true, 'new');
    expect(store.entries.size).toBe(0);
    expect(events).toEqual([{ kind: 'reseal-failed', name: 'Work' }]);
  });
});

describe('forget, release and own copy (spec 3.7)', () => {
  it('forgetAll reports only when something was forgotten', () => {
    expect(forgetAll(deps(), 'sign-out')).toBe(false);
    store.entries.set('L1', { password: 'p', userId: null });
    expect(forgetAll(deps(), 'sign-out')).toBe(true);
    expect(events).toEqual([{ kind: 'forgotten', reason: 'sign-out', name: null }]);
  });

  it('release of the startup vault resets it to the hub', () => {
    store.entries.set('L1', { password: 'p', userId: null });
    afterRelease(deps(), '/v/Other.conduit');
    expect(startup).toMatchObject({ kind: 'personal' });
    afterRelease(deps(), WORK);
    expect(startup).toEqual({ kind: 'hub' });
    expect(store.entries.size).toBe(0);
    expect(events).toEqual([{ kind: 'forgotten', reason: 'release', name: 'Work' }]);
  });

  it('own copy moves the startup vault to the copy and forgets the saved unlock', () => {
    store.entries.set('L1', { password: 'p', userId: null });
    afterOwnCopy(deps(), WORK, { path: '/v/Mine.conduit', lineageId: 'L9' });
    expect(startup).toEqual({ kind: 'personal', path: '/v/Mine.conduit', lineageId: 'L9' });
    expect(store.entries.size).toBe(0);
    expect(events).toEqual([{ kind: 'forgotten', reason: 'own-copy', name: 'Work' }]);
  });
});

describe('watchAccountChange', () => {
  function fakeAuth() {
    const init: (() => void)[] = [];
    const change: (() => void)[] = [];
    const a = {
      initialized: false,
      onInitialized: (cb: () => void) => init.push(cb),
      onStateChange: (cb: () => void) => change.push(cb),
      hasInitialized: () => a.initialized,
      finishInit: () => {
        a.initialized = true;
        init.forEach((cb) => cb());
      },
      change: () => change.forEach((cb) => cb()),
    };
    return a;
  }

  it('ignores the session restore at startup', () => {
    const auth = fakeAuth();
    watchAccountChange(auth, deps());
    store.entries.set('L1', { password: 'p', userId: 'user-a' });
    user = null;
    auth.change();
    user = 'user-a';
    auth.change();
    auth.finishInit();
    auth.change();
    expect(store.entries.size).toBe(1);
  });

  for (const [from, to, reason] of [['user-a', null, 'sign-out'], ['user-a', 'user-b', 'account'], [null, 'user-a', 'account']] as const) {
    it(`${from} to ${to} forgets every entry and tells the renderer once`, () => {
      const auth = fakeAuth();
      user = from;
      watchAccountChange(auth, deps());
      auth.finishInit();
      store.entries.set('L1', { password: 'p', userId: from });
      user = to;
      auth.change();
      auth.change();
      expect(store.entries.size).toBe(0);
      expect(events).toEqual([{ kind: 'forgotten', reason, name: null }]);
    });
  }

  it('a failing store never throws into auth', () => {
    const auth = fakeAuth();
    watchAccountChange(auth, deps());
    auth.finishInit();
    store.removeAll = vi.fn(() => {
      throw new Error('fs');
    });
    user = 'user-b';
    expect(() => auth.change()).not.toThrow();
  });
});
