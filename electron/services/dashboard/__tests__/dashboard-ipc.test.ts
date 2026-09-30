// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }));
vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({}) } }));

const { registerDashboardHandlers, defaultDeps, wrapVault, ENTRY_NOT_FOUND_MESSAGE, VAULT_LOCKED_MESSAGE } = await import('../../../ipc/dashboard.js');
const { VaultLockedError } = await import('../../vault/vault.js');
const { ConnectionHistoryStore } = await import('../connection-history-store.js');
const { ReachabilityChecker } = await import('../reachability.js');
const { DASHBOARD_CHANNELS } = await import('../dashboard-dto.js');

type Deps = Parameters<typeof registerDashboardHandlers>[0] & object;

class FakeIpc {
  readonly handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, raw?: unknown): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn(null, raw);
  }
}

let dir: string;
let store: ReturnType<typeof ConnectionHistoryStore.open>;
let unlocked: boolean;
let quitFns: Array<() => void>;
let aiLimits: number[];
let probeFn: ReturnType<typeof vi.fn>;

function setup(): FakeIpc {
  const ipc = new FakeIpc();
  const deps: Deps = {
    activeVault: () =>
      unlocked
        ? {
            key: 'vault:v1',
            listPasswordAges: () => [{ entryId: 'e1', setAt: '2026-01-01T00:00:00.000Z', source: 'created' as const }],
            entryForCheck: (id: string) => {
              if (id !== 'e1') throw new Error(ENTRY_NOT_FOUND_MESSAGE);
              return { id, entry_type: 'ssh', host: '127.0.0.1', port: 22 };
            },
          }
        : null,
    historyStore: () => store,
    openedHistoryStore: () => store,
    aiActivity: async (limit: number) => {
      aiLimits.push(limit);
      return { items: [], logFound: true };
    },
    reachability: new ReachabilityChecker({ probe: probeFn as never }),
    onQuit: (fn: () => void) => {
      quitFns.push(fn);
    },
  };
  registerDashboardHandlers(deps, ipc);
  return ipc;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-dash-ipc-'));
  store = ConnectionHistoryStore.open(path.join(dir, 'connection-history.db'));
  unlocked = true;
  quitFns = [];
  aiLimits = [];
  probeFn = vi.fn(() => {
    const result = Promise.resolve({ status: 'reachable', latencyMs: 3 });
    return { result, idle: result.then(() => undefined) };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dashboard IPC channels', () => {
  it('registers all eight channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(Object.values(DASHBOARD_CHANNELS).sort());
  });

  it('records a start and end and lists it for the active vault', async () => {
    const ipc = setup();
    const res = (await ipc.invoke('connection_history_start', { entryId: 'e1', protocol: 'ssh' })) as { id: string };
    expect(res.id).toEqual(expect.any(String));
    await ipc.invoke('connection_history_end', { id: res.id, outcome: 'failed' });
    expect(await ipc.invoke('connection_history_recent', {})).toEqual([expect.objectContaining({ entryId: 'e1', lastOutcome: 'failed', count: 1 })]);
    expect(await ipc.invoke('connection_history_for_entry', { entryId: 'e1' })).toEqual([expect.objectContaining({ id: res.id, outcome: 'failed' })]);
    expect(await ipc.invoke('connection_history_clear', {})).toEqual({ deleted: 1 });
  });

  it('gives the locked answers', async () => {
    const ipc = setup();
    const open = (await ipc.invoke('connection_history_start', { entryId: 'e1', protocol: 'web' })) as { id: string };
    unlocked = false;
    await expect(ipc.invoke('connection_history_start', { entryId: 'e1', protocol: 'ssh' })).resolves.toBeNull();
    await expect(ipc.invoke('connection_history_end', { id: open.id, outcome: 'closed' })).resolves.toBeUndefined();
    await expect(ipc.invoke('connection_history_recent')).resolves.toEqual([]);
    await expect(ipc.invoke('connection_history_for_entry', { entryId: 'e1' })).resolves.toEqual([]);
    await expect(ipc.invoke('connection_history_clear', {})).resolves.toEqual({ deleted: 0 });
    await expect(ipc.invoke('password_age_list', {})).resolves.toEqual([]);
    await expect(ipc.invoke('ai_activity_recent', {})).resolves.toEqual({ items: [], logFound: false });
    expect(aiLimits).toEqual([]);
    await expect(ipc.invoke('reachability_check', { entryId: 'e1' })).rejects.toThrow(VAULT_LOCKED_MESSAGE);
    unlocked = true;
    expect(store.forEntry('vault:v1', 'e1', 5)[0]).toMatchObject({ id: open.id, outcome: 'closed' });
  });

  it('returns password ages and checks reachability of a known entry', async () => {
    const ipc = setup();
    await expect(ipc.invoke('password_age_list', {})).resolves.toEqual([{ entryId: 'e1', setAt: '2026-01-01T00:00:00.000Z', source: 'created' }]);
    await expect(ipc.invoke('reachability_check', { entryId: 'e1' })).resolves.toMatchObject({ entryId: 'e1', status: 'reachable', host: '127.0.0.1', port: 22 });
    await expect(ipc.invoke('reachability_check', { entryId: 'gone' })).rejects.toThrow(ENTRY_NOT_FOUND_MESSAGE);
  });

  it('clamps limits with the contract constants', async () => {
    const ipc = setup();
    const recent = vi.spyOn(store, 'recent');
    const forEntry = vi.spyOn(store, 'forEntry');
    await ipc.invoke('connection_history_recent', {});
    await ipc.invoke('connection_history_recent', { limit: 500 });
    await ipc.invoke('connection_history_recent', { limit: 0 });
    await ipc.invoke('connection_history_recent', { limit: 3.7 });
    expect(recent.mock.calls.map((c) => c[1])).toEqual([8, 50, 1, 3]);
    await ipc.invoke('connection_history_for_entry', { entryId: 'e1' });
    await ipc.invoke('connection_history_for_entry', { entryId: 'e1', limit: 1000 });
    expect(forEntry.mock.calls.map((c) => c[2])).toEqual([20, 100]);
    await ipc.invoke('ai_activity_recent', {});
    await ipc.invoke('ai_activity_recent', { limit: -4 });
    await ipc.invoke('ai_activity_recent', { limit: 101 });
    expect(aiLimits).toEqual([20, 1, 100]);
  });

  it('rejects malformed arguments with Invalid request', async () => {
    const ipc = setup();
    const bad: Array<[string, unknown]> = [
      ['connection_history_start', { entryId: '', protocol: 'ssh' }],
      ['connection_history_start', { entryId: 'x'.repeat(129), protocol: 'ssh' }],
      ['connection_history_start', { entryId: 'e1', protocol: 'telnet' }],
      ['connection_history_start', { entryId: 7, protocol: 'ssh' }],
      ['connection_history_start', 'e1'],
      ['connection_history_start', ['e1']],
      ['connection_history_end', { id: 'r1', outcome: 'open' }],
      ['connection_history_end', { id: 'r1', outcome: 'interrupted' }],
      ['connection_history_end', { outcome: 'closed' }],
      ['connection_history_recent', { limit: '8' }],
      ['connection_history_recent', { limit: Number.NaN }],
      ['connection_history_for_entry', { limit: 5 }],
      ['ai_activity_recent', { limit: Infinity }],
      ['reachability_check', {}],
      ['reachability_check', { entryId: null }],
    ];
    for (const [channel, args] of bad) {
      await expect(ipc.invoke(channel, args), `${channel} ${JSON.stringify(args)}`).rejects.toThrow(/^Invalid request$/);
    }
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('turns unexpected errors into a generic message without details', async () => {
    const ipc = setup();
    vi.spyOn(store, 'recent').mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: web01.example.com');
    });
    await expect(ipc.invoke('connection_history_recent', {})).rejects.toThrow('Could not load that. Try again.');
    expect(JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('web01');
  });

  it('marks open rows interrupted for a renderer that started again, locked or not', async () => {
    const ipc = setup();
    const a = (await ipc.invoke('connection_history_start', { entryId: 'e1', protocol: 'ssh' })) as { id: string };
    unlocked = false;
    await expect(ipc.invoke('connection_history_interrupt_open', {})).resolves.toEqual({ interrupted: 1 });
    await expect(ipc.invoke('connection_history_interrupt_open', {})).resolves.toEqual({ interrupted: 0 });
    expect(store.forEntry('vault:v1', 'e1', 5)[0]).toMatchObject({ id: a.id, outcome: 'interrupted' });
  });

  it('closes open rows when the app quits', async () => {
    const ipc = setup();
    await ipc.invoke('connection_history_start', { entryId: 'e1', protocol: 'rdp' });
    expect(quitFns).toHaveLength(1);
    quitFns[0]();
    expect(store.forEntry('vault:v1', 'e1', 5)[0]).toMatchObject({ outcome: 'closed' });
  });
});

describe('defaultDeps and wrapVault', () => {
  interface FakeVault {
    isUnlocked(): boolean;
    peekVaultId(): string | null;
    getFilePath(): string;
    listPasswordAges(): never[];
    getEntryMeta(id: string): { id: string; entry_type: string; host: string | null; port: number | null };
  }

  function vault(overrides: Partial<FakeVault> = {}): FakeVault {
    return {
      isUnlocked: () => true,
      peekVaultId: () => 'vid-1',
      getFilePath: () => '/tmp/personal.conduit',
      listPasswordAges: () => [],
      getEntryMeta: (id) => ({ id, entry_type: 'ssh', host: 'h', port: 22 }),
      ...overrides,
    };
  }

  function appState(personal: FakeVault, team: FakeVault | null = null, teamId: string | null = null) {
    return { vault: personal, teamVaultManager: { getActiveVault: () => team, getActiveVaultId: () => teamId } };
  }

  it('keys a personal vault by its vault id, else by its path', () => {
    expect(defaultDeps(appState(vault())).activeVault()?.key).toBe('vault:vid-1');
    const byPath = defaultDeps(appState(vault({ peekVaultId: () => null }))).activeVault()?.key;
    expect(byPath).toMatch(/^path:[0-9a-f]{32}$/);
  });

  it('keys the active team vault by its team vault id and never peeks its vault id', () => {
    const peek = vi.fn(() => 'should-not-read');
    const deps = defaultDeps(appState(vault(), vault({ peekVaultId: peek }), 'tv-9'));
    expect(deps.activeVault()?.key).toBe('team:tv-9');
    expect(peek).not.toHaveBeenCalled();
  });

  it('gives null for a locked vault and for a sync-blocked one', () => {
    expect(defaultDeps(appState(vault({ isUnlocked: () => false }))).activeVault()).toBeNull();
    const blocked = vault({
      peekVaultId: () => {
        throw new VaultLockedError();
      },
    });
    expect(defaultDeps(appState(blocked)).activeVault()).toBeNull();
  });

  it('rethrows other errors from reading the vault id', () => {
    const broken = vault({
      peekVaultId: () => {
        throw new Error('disk');
      },
    });
    expect(() => defaultDeps(appState(broken)).activeVault()).toThrow('disk');
  });

  it('maps entry lookups: locked gives Vault is locked, anything else Entry not found', () => {
    const locked = wrapVault(
      vault({
        getEntryMeta: () => {
          throw new VaultLockedError();
        },
      }),
      'k',
    );
    expect(() => locked.entryForCheck('e1')).toThrow(VAULT_LOCKED_MESSAGE);
    const missing = wrapVault(
      vault({
        getEntryMeta: () => {
          throw new Error('Entry not found: e1 at /secret/path');
        },
      }),
      'k',
    );
    expect(() => missing.entryForCheck('e1')).toThrow(new Error(ENTRY_NOT_FOUND_MESSAGE));
    expect(wrapVault(vault(), 'k').entryForCheck('e1')).toEqual({ id: 'e1', entry_type: 'ssh', host: 'h', port: 22 });
  });

  it('gives no password ages while locked and rethrows other errors', () => {
    const locked = wrapVault(
      vault({
        listPasswordAges: () => {
          throw new VaultLockedError();
        },
      }),
      'k',
    );
    expect(locked.listPasswordAges()).toEqual([]);
    const broken = wrapVault(
      vault({
        listPasswordAges: () => {
          throw new Error('disk');
        },
      }),
      'k',
    );
    expect(() => broken.listPasswordAges()).toThrow('disk');
  });
});
