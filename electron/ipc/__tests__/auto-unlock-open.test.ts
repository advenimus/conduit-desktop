// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { silenceConsole } from './sync-fakes.js';
import { parseAutoUnlockArgs, runAutoUnlock, type AutoUnlockDeps } from '../auto-unlock-open.js';
import { StartupAttempt, type StartupVault } from '../startup-vault-core.js';
import type { ReadResult } from '../../services/vault/auto-unlock-store.js';
import type { PersonalOpenRequest } from '../../services/sync/app-sync-manager.js';
import {
  INVALID_PASSWORD_MESSAGE,
  OPEN_CANCELLED_MESSAGE,
  VAULT_NOT_FOUND_MESSAGE,
  changedElsewhereError,
  openElsewhereError,
} from '../../services/vault-session/open-errors.js';

const WORK = '/v/Work.conduit';

interface World {
  read: ReadResult;
  entries: number;
  user: string | null;
  initialized: boolean;
  current: string;
  prepared: string[];
  opens: PersonalOpenRequest[];
  failWith: unknown[];
  held: number;
  heldAtOpen: number[];
  startup: StartupVault | null;
}

let w: World;
let attempt: StartupAttempt;

function deps(): AutoUnlockDeps {
  return {
    store: {
      status: () => ({ usable: true, reason: 'ok', backend: 'keychain', storeName: 'system keychain' }),
      dir: () => '/x',
      sealPassword: async () => ({ ok: true }),
      readPassword: () => w.read,
      hasEntry: () => w.entries > 0,
      removeEntry: () => false,
      removeAll: () => {
        const n = w.entries;
        w.entries = 0;
        return n;
      },
      removeAllExcept: () => 0,
    },
    attempt,
    readStartup: () => w.startup,
    authInitialized: () => w.initialized,
    userId: () => w.user,
    currentPath: () => w.current,
    prepare: async (p) => {
      w.prepared.push(p);
      w.current = p;
    },
    open: async (req, onRefused) => {
      w.opens.push(req);
      w.heldAtOpen.push(w.held);
      const err = w.failWith.shift();
      if (err === undefined) return {};
      await onRefused(err);
      throw err instanceof Error ? new Error(err.message) : err;
    },
    holdMcp: () => {
      w.held += 1;
    },
  };
}

const run = (args: unknown = {}) => runAutoUnlock(deps(), parseAutoUnlockArgs(args));

beforeEach(() => {
  silenceConsole();
  w = {
    read: { kind: 'ok', password: 'saved-pw', userId: 'user-a' },
    entries: 1,
    user: 'user-a',
    initialized: true,
    current: '/v/Default.conduit',
    prepared: [],
    opens: [],
    failWith: [],
    held: 0,
    heldAtOpen: [],
    startup: { kind: 'personal', path: WORK, lineageId: 'L1' },
  };
  attempt = new StartupAttempt(Date.now);
  attempt.consume();
});

describe('vault_auto_unlock first try', () => {
  it('opens the startup vault with the saved password, source auto_unlock, and holds MCP', async () => {
    expect(await run()).toEqual({ ok: true });
    expect(w.prepared).toEqual([WORK]);
    expect(w.opens).toEqual([{ path: WORK, password: 'saved-pw', previousPassword: null, takeover: false, recoverWorkingCopy: false, source: 'auto_unlock' }]);
    expect(w.held).toBe(1);
    expect(attempt.attemptKind()).toBeNull();
  });

  it('holds MCP before the open starts, since the vault is readable before the open returns', async () => {
    expect(await run()).toEqual({ ok: true });
    expect(w.heldAtOpen).toEqual([1]);
  });

  it('a typed password in a fallback never holds MCP', async () => {
    await run({ password: 'typed' });
    expect(w.held).toBe(0);
  });

  it('forces takeover off even when asked', async () => {
    await run({ takeover: true });
    expect(w.opens[0].takeover).toBe(false);
  });

  it('refuses without an armed attempt, and a second call is refused', async () => {
    await run();
    expect(await run()).toEqual({ ok: false, fallback: 'not-allowed' });
    expect(w.opens).toHaveLength(1);
  });

  it('account check: auth not settled or another user forgets the entry', async () => {
    w.initialized = false;
    expect(await run()).toEqual({ ok: false, fallback: 'account' });
    expect(w.entries).toBe(0);
    expect(w.opens).toHaveLength(0);
    attempt = new StartupAttempt(Date.now);
    attempt.consume();
    w.initialized = true;
    w.entries = 1;
    w.user = 'user-b';
    expect(await run()).toEqual({ ok: false, fallback: 'account' });
    expect(w.entries).toBe(0);
  });

  it('an unreadable entry is kept and gives the unreadable prompt for that vault', async () => {
    w.read = { kind: 'unreadable' };
    expect(await run()).toEqual({ ok: false, fallback: 'unreadable' });
    expect(w.entries).toBe(1);
    expect(w.current).toBe(WORK);
  });

  it('an invalid saved password is forgotten at once and never retried', async () => {
    w.failWith = [new Error(INVALID_PASSWORD_MESSAGE)];
    expect(await run()).toEqual({ ok: false, fallback: 'stale' });
    expect(w.entries).toBe(0);
    expect(w.opens).toHaveLength(1);
  });

  it('changed elsewhere forgets the entry and still sends the structured error', async () => {
    w.failWith = [changedElsewhereError({ changedByDeviceName: 'Mac', changedMs: 1, needsPreviousPassword: false, deleteBiometric: false })];
    const err = (await run().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('VAULT_PASSWORD_CHANGED_ELSEWHERE');
    expect(w.entries).toBe(0);
  });

  it('a gate error reaches the renderer unchanged and keeps the entry', async () => {
    const gate = openElsewhereError({ fileName: 'Work.conduit', holders: [], limit: 1, ownLocation: '/v', via: 'server' });
    w.failWith = [gate];
    const err = (await run().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(gate.message);
    expect(w.entries).toBe(1);
  });

  it('a file gone after the plan gives missing-file; a cancel ends the attempt', async () => {
    w.failWith = [new Error(VAULT_NOT_FOUND_MESSAGE)];
    expect(await run()).toEqual({ ok: false, fallback: 'missing-file' });
    attempt = new StartupAttempt(Date.now);
    attempt.consume();
    w.failWith = [new Error(OPEN_CANCELLED_MESSAGE)];
    await expect(run()).rejects.toThrow(OPEN_CANCELLED_MESSAGE);
    expect(attempt.attemptKind()).toBeNull();
  });

  it('no handler result carries the password', async () => {
    expect(JSON.stringify(await run())).not.toContain('saved-pw');
  });
});

describe('vault_auto_unlock retries (spec 4.3, 3.6)', () => {
  beforeEach(async () => {
    w.failWith = [openElsewhereError({ fileName: 'Work.conduit', holders: [], limit: 1, ownLocation: '/v', via: 'server' })];
    await run().catch(() => undefined);
  });

  it('a take-over retry reuses the held password and may take over', async () => {
    expect(await run({ takeover: true })).toEqual({ ok: true });
    expect(w.heldAtOpen).toEqual([1, 2]);
    expect(w.opens[1]).toMatchObject({ password: 'saved-pw', takeover: true, source: 'auto_unlock' });
  });

  it('a typed password uses the held saved password as the previous one', async () => {
    expect(await run({ password: 'new-pw' })).toEqual({ ok: true });
    expect(w.opens[1]).toMatchObject({ password: 'new-pw', previousPassword: 'saved-pw', source: 'vault_unlock' });
  });

  it('a retry is refused once another vault is current', async () => {
    w.current = '/v/Other.conduit';
    expect(await run({ takeover: true })).toEqual({ ok: false, fallback: 'not-allowed' });
  });
});
