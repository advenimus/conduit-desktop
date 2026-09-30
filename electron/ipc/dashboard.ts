/**
 * IPC channels of the Home dashboard (docs/DASHBOARD.md 9.2): local connection history,
 * password ages, AI activity from the MCP audit log and the reachability check. Every argument
 * object is validated here; locked vaults get the empty answers the contract lists.
 */

import path from 'node:path';
import { app, ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { getDataDir, getEnvConfig } from '../services/env-config.js';
import { VaultLockedError } from '../services/vault/vault.js';
import {
  AI_ACTIVITY_DEFAULT,
  AI_ACTIVITY_MAX,
  DASHBOARD_CHANNELS,
  HISTORY_ENTRY_DEFAULT,
  HISTORY_ENTRY_MAX,
  HISTORY_RECENT_DEFAULT,
  HISTORY_RECENT_MAX,
  type AiActivityResponse,
  type ConnectionHistoryEvent,
  type HistoryClearResponse,
  type HistoryStartResponse,
  type PasswordAgeItem,
  type ReachabilityResult,
  type RecentConnection,
} from '../services/dashboard/dashboard-dto.js';
import {
  InvalidDashboardRequest,
  argsObject,
  clampLimit,
  parseHistoryEnd,
  parseHistoryForEntry,
  parseHistoryStart,
  parseReachability,
  type DashboardArgs,
} from '../services/dashboard/dashboard-args.js';
import { ConnectionHistoryStore, HISTORY_FILE_NAME } from '../services/dashboard/connection-history-store.js';
import { historyVaultKey } from '../services/dashboard/vault-key.js';
import { auditLogPath, readAiActivity } from '../services/dashboard/ai-activity.js';
import { ReachabilityChecker, type ReachabilityEntry } from '../services/dashboard/reachability.js';

export const VAULT_LOCKED_MESSAGE = 'Vault is locked';
export const ENTRY_NOT_FOUND_MESSAGE = 'Entry not found';
const GENERIC_MESSAGE = 'Could not load that. Try again.';
const PASS_THROUGH: ReadonlySet<string> = new Set([VAULT_LOCKED_MESSAGE, ENTRY_NOT_FOUND_MESSAGE]);

/** The unlocked active vault as the dashboard channels see it. */
export interface DashboardVault {
  /** Scopes connection history to this vault (never sent by the renderer). */
  readonly key: string;
  listPasswordAges(): PasswordAgeItem[];
  /** Throws VAULT_LOCKED_MESSAGE or ENTRY_NOT_FOUND_MESSAGE. */
  entryForCheck(entryId: string): ReachabilityEntry;
}

export interface DashboardDeps {
  /** null when no vault is unlocked. */
  activeVault(): DashboardVault | null;
  /** Opens the store on first use. */
  historyStore(): ConnectionHistoryStore;
  /** The store when this process already opened it, else null. */
  openedHistoryStore(): ConnectionHistoryStore | null;
  aiActivity(limit: number): Promise<AiActivityResponse>;
  readonly reachability: ReachabilityChecker;
  /** Runs `fn` once when the app quits. */
  onQuit(fn: () => void): void;
}

/** The part of ipcMain the registrar uses (tests pass a fake). */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void;
}

type Handler = (args: DashboardArgs) => unknown;

function wrapVault(vault: { listPasswordAges(): PasswordAgeItem[]; getEntryMeta(id: string): ReachabilityEntry }, key: string): DashboardVault {
  return {
    key,
    listPasswordAges: () => {
      try {
        return vault.listPasswordAges();
      } catch (err) {
        if (err instanceof VaultLockedError) return [];
        throw err;
      }
    },
    entryForCheck: (entryId) => {
      try {
        const { id, entry_type, host, port } = vault.getEntryMeta(entryId);
        return { id, entry_type, host, port };
      } catch (err) {
        if (err instanceof VaultLockedError) throw new Error(VAULT_LOCKED_MESSAGE);
        throw new Error(ENTRY_NOT_FOUND_MESSAGE);
      }
    },
  };
}

function defaultDeps(): DashboardDeps {
  const state = AppState.getInstance();
  let store: ConnectionHistoryStore | null = null;
  return {
    activeVault: () => {
      const team = state.teamVaultManager.getActiveVault();
      const vault = team ?? state.vault;
      if (!vault.isUnlocked()) return null;
      try {
        const teamVaultId = team ? state.teamVaultManager.getActiveVaultId() : null;
        const vaultId = teamVaultId ? null : vault.peekVaultId();
        return wrapVault(vault, historyVaultKey({ teamVaultId, vaultId, vaultPath: vault.getFilePath() }));
      } catch (err) {
        if (err instanceof VaultLockedError) return null;
        throw err;
      }
    },
    historyStore: () => {
      store ??= ConnectionHistoryStore.open(path.join(getDataDir(), HISTORY_FILE_NAME));
      return store;
    },
    openedHistoryStore: () => store,
    aiActivity: (limit) => readAiActivity({ logPath: auditLogPath(), environment: getEnvConfig().environment, limit }),
    reachability: new ReachabilityChecker(),
    onQuit: (fn) => {
      app.on('will-quit', fn);
    },
  };
}

function toIpcError(channel: string, err: unknown): Error {
  if (err instanceof InvalidDashboardRequest) return new Error(err.message);
  if (err instanceof Error && PASS_THROUGH.has(err.message)) return new Error(err.message);
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: unknown } | null)?.code;
  console.error(`[dashboard] ${channel} failed`, { name, code: typeof code === 'string' ? code : null });
  return new Error(GENERIC_MESSAGE);
}

export function registerDashboardHandlers(deps: DashboardDeps = defaultDeps(), ipc: IpcRegistrar = ipcMain): void {
  const on = (channel: string, fn: Handler): void => {
    ipc.handle(channel, async (_event: unknown, raw: unknown) => {
      try {
        return await fn(argsObject(raw));
      } catch (err) {
        throw toIpcError(channel, err);
      }
    });
  };

  on(DASHBOARD_CHANNELS.historyStart, (a): HistoryStartResponse => {
    const { entryId, protocol } = parseHistoryStart(a);
    const vault = deps.activeVault();
    if (vault === null) return null;
    return { id: deps.historyStore().start(vault.key, entryId, protocol) };
  });

  on(DASHBOARD_CHANNELS.historyEnd, (a): void => {
    const { id, outcome } = parseHistoryEnd(a);
    deps.historyStore().end(id, outcome);
  });

  on(DASHBOARD_CHANNELS.historyRecent, (a): RecentConnection[] => {
    const limit = clampLimit(a.limit, HISTORY_RECENT_DEFAULT, HISTORY_RECENT_MAX);
    const vault = deps.activeVault();
    return vault === null ? [] : deps.historyStore().recent(vault.key, limit);
  });

  on(DASHBOARD_CHANNELS.historyForEntry, (a): ConnectionHistoryEvent[] => {
    const { entryId, limit } = parseHistoryForEntry(a, HISTORY_ENTRY_DEFAULT, HISTORY_ENTRY_MAX);
    const vault = deps.activeVault();
    return vault === null ? [] : deps.historyStore().forEntry(vault.key, entryId, limit);
  });

  on(DASHBOARD_CHANNELS.historyClear, (): HistoryClearResponse => {
    const vault = deps.activeVault();
    return { deleted: vault === null ? 0 : deps.historyStore().clear(vault.key) };
  });

  on(DASHBOARD_CHANNELS.passwordAges, (): PasswordAgeItem[] => deps.activeVault()?.listPasswordAges() ?? []);

  on(DASHBOARD_CHANNELS.aiActivity, (a): Promise<AiActivityResponse> =>
    deps.aiActivity(clampLimit(a.limit, AI_ACTIVITY_DEFAULT, AI_ACTIVITY_MAX)),
  );

  on(DASHBOARD_CHANNELS.reachabilityCheck, (a): Promise<ReachabilityResult> => {
    const { entryId } = parseReachability(a);
    const vault = deps.activeVault();
    if (vault === null) throw new Error(VAULT_LOCKED_MESSAGE);
    return deps.reachability.check(vault.entryForCheck(entryId));
  });

  deps.onQuit(() => {
    try {
      deps.openedHistoryStore()?.closeOpenRows();
    } catch (err) {
      console.warn('[dashboard] could not close open history rows at quit', { name: err instanceof Error ? err.name : 'Error' });
    }
  });
}
