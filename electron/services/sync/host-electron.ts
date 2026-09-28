/**
 * Electron adapters of the sync host (host.ts, spec 3.2, 5.4, 5.5, 5.8, 8.1): renderer events
 * to every window, shell.trashItem, device facts, the signed-in account, settings facts, the
 * personal_sync kill switch, the network and cloud-folder path test, PBKDF2, and the working
 * copy through ConduitVault (host-electron-vault.ts). Built once per launch by the app sync
 * manager; nothing here holds vault state.
 */

import { BrowserWindow, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { deriveKey } from '../vault/crypto.js';
import { NetworkLockService } from '../vault/network-lock.js';
import { createConsoleLogger, createNodeSyncFs, createNodeTimers, nodeRandom, systemClock } from './host-node.js';
import {
  cachedTierCapabilities,
  listedVaultPaths,
  sameRealpath,
  type SettingsSource,
} from './host-electron-settings.js';
import { createVaultWorkingCopyHost, type SyncableVault } from './host-electron-vault.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type {
  AccountProvider,
  AppFacts,
  DeviceInfo,
  DevicePlatform,
  FeatureFlags,
  Kdf,
  PathClassifier,
  RendererEmitter,
  SyncEventMap,
  SyncHost,
  SyncLogger,
} from './host.js';

export type { SyncableVault } from './host-electron-vault.js';
export type { SettingsSource } from './host-electron-settings.js';

/** Existing renderer event that makes the entry store reload (App.tsx). */
export const ENTRIES_REFRESHED_EVENT = 'vault:entries-refreshed';
/** 8.1 kill switch value. */
export const PERSONAL_SYNC_PAUSED = 'paused';
const SCUTIL_PATH = '/usr/sbin/scutil';
const SCUTIL_TIMEOUT_MS = 2000;
const MAC_LOCAL_SUFFIX = /\.local$/i;

/** 5.4: cloud folders the legacy isNetworkPath misses (whole path segments, case-insensitive). */
const CLOUD_SEGMENTS: ReadonlySet<string> = new Set([
  'cloudstorage',
  'icloud drive',
  'iclouddrive',
  'mobile documents',
  'box',
  'box sync',
  'nextcloud',
  'synologydrive',
]);
/** Segment prefixes ("OneDrive - Contoso", "GoogleDrive-me@x", "Dropbox (Personal)"). */
const CLOUD_SEGMENT_PREFIXES = ['onedrive', 'dropbox', 'google drive', 'googledrive'] as const;

// ---------- Renderer events ----------

/** The parts of a BrowserWindow the emitter uses (tests pass fakes). */
export interface WindowLike {
  isDestroyed(): boolean;
  readonly webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
}

export type WindowList = () => readonly WindowLike[];

export const allWindows: WindowList = () => BrowserWindow.getAllWindows();

/** Sends one event to every live window; a failing window is logged and skipped. */
export function sendToAll(windows: WindowList, logger: SyncLogger, channel: string, payload?: unknown): void {
  for (const win of windows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      if (payload === undefined) win.webContents.send(channel);
      else win.webContents.send(channel, payload);
    } catch (err) {
      logger.warn(`${SYNC_LOG_PREFIX} renderer event not delivered`, { channel, name: (err as Error)?.name ?? 'Error' });
    }
  }
}

export function createRendererEmitter<M>(windows: WindowList, logger: SyncLogger): RendererEmitter<M> {
  return {
    emit(channel, payload) {
      sendToAll(windows, logger, channel, payload);
    },
  };
}

// ---------- Paths ----------

function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
}

/** 5.4 additions: macOS CloudStorage, iCloud for Windows, Box, Nextcloud, Synology, provider folders. */
export function isCloudFolderPath(p: string): boolean {
  return pathSegments(p).some((seg) => CLOUD_SEGMENTS.has(seg) || CLOUD_SEGMENT_PREFIXES.some((x) => seg.startsWith(x)));
}

export function isNetworkOrCloudPath(p: string): boolean {
  return NetworkLockService.isNetworkPath(p) || isCloudFolderPath(p);
}

export const electronPaths: PathClassifier = { isNetworkPath: isNetworkOrCloudPath, platform: process.platform };

// ---------- Device ----------

export function devicePlatform(platform: NodeJS.Platform = process.platform): DevicePlatform {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/** "Chris's MacBook Pro" on macOS (ComputerName), else the host name without ".local". */
function friendlyDeviceName(logger: SyncLogger): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync(SCUTIL_PATH, ['--get', 'ComputerName'], { encoding: 'utf8', timeout: SCUTIL_TIMEOUT_MS }).trim();
      if (name !== '') return name;
    } catch (err) {
      logger.debug(`${SYNC_LOG_PREFIX} ComputerName unavailable; using the host name`, { name: (err as Error)?.name ?? 'Error' });
    }
  }
  return os.hostname().replace(MAC_LOCAL_SUFFIX, '') || 'This computer';
}

export function createDeviceInfo(appVersion: string, logger: SyncLogger): { current(): DeviceInfo } {
  let cached: DeviceInfo | null = null;
  return {
    current(): DeviceInfo {
      cached ??= { name: friendlyDeviceName(logger), platform: devicePlatform(), appVersion };
      return cached;
    },
  };
}

// ---------- Account, flags, facts ----------

/** The parts of AuthService's state the hosts read (AuthService satisfies it structurally). */
export interface AuthStateLike {
  readonly user: { readonly id: string } | null;
  readonly emailConfirmed: boolean;
  readonly profile: { readonly tier?: { readonly features: Readonly<Record<string, unknown>> } } | null;
}

export interface AuthSource {
  getAuthState(): AuthStateLike;
}

/** Signed in = a confirmed user (cached mode included: its RPCs fail and stay unconfirmed). */
export function createAccountProvider(auth: AuthSource): AccountProvider {
  return {
    userId: () => {
      const s = auth.getAuthState();
      return s.user !== null && s.emailConfirmed ? s.user.id : null;
    },
  };
}

/** Live profile features first, then cached_tier_capabilities (offline or cached mode). */
export function tierFeature(auth: AuthSource, settings: SettingsSource, key: string): unknown {
  const live = auth.getAuthState().profile?.tier?.features;
  if (live !== undefined && key in live) return live[key];
  return cachedTierCapabilities(settings.read())?.[key];
}

export function createFeatureFlags(auth: AuthSource, settings: SettingsSource, logger: SyncLogger): FeatureFlags {
  return {
    personalSyncPaused: () => {
      try {
        return tierFeature(auth, settings, 'personal_sync') === PERSONAL_SYNC_PAUSED;
      } catch (err) {
        logger.warn(`${SYNC_LOG_PREFIX} kill switch unreadable; sync stays on`, { name: (err as Error)?.name ?? 'Error' });
        return false;
      }
    },
  };
}

export function createAppFacts(settings: SettingsSource, firstLaunchMs: () => number | null, logger: SyncLogger): AppFacts {
  return {
    settingsListsVault: (realpath) => {
      try {
        return listedVaultPaths(settings.read()).some((p) => sameRealpath(p, realpath, process.platform));
      } catch (err) {
        logger.warn(`${SYNC_LOG_PREFIX} settings unreadable for the upgrade wording`, { name: (err as Error)?.name ?? 'Error' });
        return false;
      }
    },
    thisBuildFirstLaunchMs: firstLaunchMs,
  };
}

export const vaultKdf: Kdf = {
  deriveKey: (password, saltB64) => deriveKey(password, Buffer.from(saltB64, 'base64')),
};

// ---------- Bundle ----------

export interface ElectronSyncHostDeps {
  /** The current personal vault (AppState.vault), read at each W open. */
  readonly vault: () => SyncableVault;
  readonly auth: AuthSource;
  readonly settings: SettingsSource;
  readonly appVersion: string;
  /** First launch of this build on this computer (app-sync-identity). */
  readonly firstLaunchMs: () => number | null;
  readonly windows?: WindowList;
  readonly logger?: SyncLogger;
}

export function createElectronSyncHost(deps: ElectronSyncHostDeps): SyncHost {
  const logger = deps.logger ?? createConsoleLogger();
  const windows = deps.windows ?? allWindows;
  const timers = createNodeTimers();
  return {
    clock: systemClock,
    timers,
    random: nodeRandom,
    kdf: vaultKdf,
    logger,
    fs: createNodeSyncFs(),
    events: createRendererEmitter<SyncEventMap>(windows, logger),
    paths: electronPaths,
    shell: { trashItem: (p) => shell.trashItem(p) },
    flags: createFeatureFlags(deps.auth, deps.settings, logger),
    device: createDeviceInfo(deps.appVersion, logger),
    account: createAccountProvider(deps.auth),
    app: createAppFacts(deps.settings, deps.firstLaunchMs, logger),
    workingCopy: createVaultWorkingCopyHost({
      vault: deps.vault,
      refreshRenderer: () => sendToAll(windows, logger, ENTRIES_REFRESHED_EVENT),
      timers,
      logger,
    }),
  };
}
