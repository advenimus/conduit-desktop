/**
 * Electron adapters of the device-session host (host.ts, spec 6.2, 6.6, 6.8): powerMonitor
 * suspend/resume and idle time, window focus, busy counts from the open sessions and running
 * agent jobs, the cached tier limit from settings.json, the vault access callbacks for the soft
 * lock, the session events to every window, and the supabase-js RPC and Realtime adapters
 * (host-electron-supabase.ts). Built once per launch by the app sync manager.
 */

import { app, BrowserWindow, powerMonitor } from 'electron';
import { createRendererEmitter, allWindows, type WindowList } from '../sync/host-electron.js';
import { cachedTierCapabilities, cachedTierTimestampMs, type SettingsSource } from '../sync/host-electron-settings.js';
import { SESSION_LOG_PREFIX, type Clock, type SyncHost, type SyncLogger } from '../sync/host.js';
import { createSupabaseRealtime, createSupabaseRpcCaller, type SupabaseSource } from './host-electron-supabase.js';
import type {
  ActivityHost,
  BusyHost,
  BusyReport,
  CachedTierLimit,
  PowerHost,
  SessionEventMap,
  SessionHost,
  TierCacheHost,
  VaultAccessHost,
} from './host.js';

export type { SupabaseSource } from './host-electron-supabase.js';

const P = SESSION_LOG_PREFIX;
export const VAULT_LIMIT_FEATURE = 'vault_max_open_devices';

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

// ---------- Power ----------

export function createPowerHost(): PowerHost {
  return {
    onSuspend(fn) {
      powerMonitor.on('suspend', fn);
      return () => {
        powerMonitor.removeListener('suspend', fn);
      };
    },
    onResume(fn) {
      powerMonitor.on('resume', fn);
      return () => {
        powerMonitor.removeListener('resume', fn);
      };
    },
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  };
}

// ---------- Focus ----------

export interface FocusTracker extends ActivityHost {
  /** Called when any app window gains focus (the manager triggers a 'focus' cycle). */
  onFocus(fn: () => void): () => void;
  dispose(): void;
}

export function createFocusTracker(clock: Clock, logger: SyncLogger): FocusTracker {
  let lastFocusMs: number | null = BrowserWindow.getFocusedWindow() === null ? null : clock.now();
  const listeners = new Set<() => void>();
  const onFocus = (): void => {
    lastFocusMs = clock.now();
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        logger.warn(`${P} focus listener failed`, { name: errorName(err) });
      }
    }
  };
  const onBlur = (): void => {
    lastFocusMs = clock.now();
  };
  app.on('browser-window-focus', onFocus);
  app.on('browser-window-blur', onBlur);
  return {
    isFocused: () => BrowserWindow.getFocusedWindow() !== null,
    lastFocusMs: () => (BrowserWindow.getFocusedWindow() !== null ? clock.now() : lastFocusMs),
    onFocus(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      listeners.clear();
      app.removeListener('browser-window-focus', onFocus);
      app.removeListener('browser-window-blur', onBlur);
    },
  };
}

// ---------- Busy (6.2 p_busy) ----------

/** Counts from AppState's managers; each is read defensively. */
export interface BusySources {
  readonly terminals: () => number;
  readonly rdp: () => number;
  readonly vnc: () => number;
  readonly web: () => number;
  readonly commands: () => number;
  /** Running CLI agent sessions (EngineManager). */
  readonly agentJobs: () => number;
  /** Connections opened by MCP tools (AppState.mcpConnections). */
  readonly mcpJobs: () => number;
}

function count(fn: () => number, what: string, logger: SyncLogger): number {
  try {
    const n = fn();
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch (err) {
    logger.warn(`${P} busy count unavailable`, { what, name: errorName(err) });
    return 0;
  }
}

export function createBusyHost(sources: BusySources, logger: SyncLogger): BusyHost {
  return {
    busy(): BusyReport {
      const sessions =
        count(sources.terminals, 'terminals', logger) +
        count(sources.rdp, 'rdp', logger) +
        count(sources.vnc, 'vnc', logger) +
        count(sources.web, 'web', logger) +
        count(sources.commands, 'commands', logger);
      const jobs = count(sources.agentJobs, 'agents', logger) + count(sources.mcpJobs, 'mcp', logger);
      return { sessions, jobs };
    },
  };
}

// ---------- Tier cache (6.8) ----------

export function readCachedTierLimit(settings: SettingsSource): CachedTierLimit | null {
  const s = settings.read();
  const caps = cachedTierCapabilities(s);
  const timestampMs = cachedTierTimestampMs(s);
  if (caps === null || timestampMs === null) return null;
  const v = caps[VAULT_LIMIT_FEATURE];
  return { vaultMaxOpenDevices: typeof v === 'number' && Number.isInteger(v) ? v : null, timestampMs };
}

export function createTierCacheHost(settings: SettingsSource): TierCacheHost {
  return { read: () => readCachedTierLimit(settings) };
}

// ---------- Bundle ----------

export interface ElectronSessionHostDeps {
  readonly supabase: SupabaseSource;
  readonly settings: SettingsSource;
  readonly busy: BusySources;
  /** Soft lock and in-place opens (implemented by the main-process vault IPC module). */
  readonly access: VaultAccessHost;
  readonly focus: FocusTracker;
  readonly windows?: WindowList;
}

export function createElectronSessionHost(sync: SyncHost, deps: ElectronSessionHostDeps): SessionHost {
  const windows = deps.windows ?? allWindows;
  return {
    ...sync,
    rpc: createSupabaseRpcCaller(deps.supabase, sync.logger),
    realtime: createSupabaseRealtime(deps.supabase, sync.timers, sync.logger),
    power: createPowerHost(),
    activity: deps.focus,
    busy: createBusyHost(deps.busy, sync.logger),
    tierCache: createTierCacheHost(deps.settings),
    access: deps.access,
    sessionEvents: createRendererEmitter<SessionEventMap>(windows, sync.logger),
  };
}
