/**
 * IPC handlers for auto-update functionality.
 *
 * Uses electron-updater with GitHub Releases on advenimus/conduit-desktop.
 * Handles: cached update state, periodic checks, listener-leak prevention,
 * separated download/install flow, and error forwarding.
 */

import { ipcMain, app, shell } from 'electron';
import { getEnvConfig } from '../services/env-config.js';
import { AppState } from '../services/state.js';
import { setIsQuitting } from '../services/app-lifecycle.js';
import { appQuitFlush } from '../services/vault/app-quit-flush.js';
import { installAfterVaultFlush } from './update-install.js';
import { readSettings, writeSettings } from './settings.js';
import { applyUpdateChannel, getEffectiveBetaUpdates, isPrereleaseVersion } from '../services/update-channel.js';
import { createPendingUpdateGate, type PendingUpdateGate } from '../services/pending-update.js';

type ElectronUpdaterModule = typeof import('electron-updater');

let autoUpdater: ElectronUpdaterModule['autoUpdater'] | null = null;
let gate: PendingUpdateGate | null = null;

/** main.ts rebuilds the Help menu on this event. */
const MENU_REFRESH_EVENT = 'conduit:update-downloaded';
const BETA_OFF_MESSAGE = 'Beta updates are off';

// ── Module-level state ─────────────────────────────────────────────────
interface CachedUpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  downloaded: boolean;
}

let cachedUpdateInfo: CachedUpdateInfo | null = null;
let checkInFlight: Promise<CachedUpdateInfo | null> | null = null;
let periodicCheckTimer: ReturnType<typeof setInterval> | null = null;

/** Tracks the downloaded version for dynamic menu label. */
export let downloadedVersion: string | null = null;

/** Strip HTML tags from release notes (GitHub returns HTML for markdown bodies). */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    const mod = await import('electron-updater');
    // electron-updater is CJS — autoUpdater is a lazy getter on module.exports.
    // ESM interop puts module.exports on .default; named export may be missing.
    const cjs = (mod as { readonly default?: Partial<Pick<ElectronUpdaterModule, 'autoUpdater'>> }).default;
    autoUpdater = mod.autoUpdater ?? cjs?.autoUpdater ?? null;
    if (autoUpdater) gate = createPendingUpdateGate(autoUpdater, betaUpdatesEnabled);
    return autoUpdater;
  } catch (err) {
    console.error('[updater] Failed to import electron-updater:', err);
    return null;
  }
}

function betaUpdatesEnabled(): boolean {
  return getEffectiveBetaUpdates(readSettings().beta_updates, app.getVersion());
}

/** Forgets a beta that may no longer install, and tells the overlay and Help menu. */
function dropBlockedUpdate(): void {
  cachedUpdateInfo = null;
  downloadedVersion = null;
  AppState.getInstance().getMainWindow()?.webContents.send('update:cleared');
  app.emit(MENU_REFRESH_EVENT);
}

/** Perform an update check, guarded against concurrent calls. */
async function doUpdateCheck(): Promise<CachedUpdateInfo | null> {
  if (checkInFlight) return cachedUpdateInfo;
  checkInFlight = runUpdateCheck();
  try {
    return await checkInFlight;
  } finally {
    checkInFlight = null;
  }
}

/** Waits out a check that may have used the old channel, then checks again from scratch. */
async function freshUpdateCheck(): Promise<CachedUpdateInfo | null> {
  if (checkInFlight) await checkInFlight.catch(() => null);
  cachedUpdateInfo = null;
  return doUpdateCheck();
}

async function runUpdateCheck(): Promise<CachedUpdateInfo | null> {
  const updater = await getAutoUpdater();
  if (!updater) return null;

  // Read fresh each time: the setting can change from the Settings dialog between checks.
  applyUpdateChannel(updater, betaUpdatesEnabled());
  try {
    const result = await updater.checkForUpdates();
    if (result && result.isUpdateAvailable && result.updateInfo) {
      // Betas may have been turned off while this check ran.
      if (gate?.track(result.updateInfo.version, result.cancellationToken, result.downloadPromise)) {
        dropBlockedUpdate();
        return null;
      }
      const notes = result.updateInfo.releaseNotes;
      let body: string | null = null;
      if (typeof notes === 'string') {
        body = stripHtml(notes);
      } else if (Array.isArray(notes)) {
        body = notes.map((n) => (typeof n === 'string' ? stripHtml(n) : stripHtml(n.note ?? ''))).join('\n');
      }

      cachedUpdateInfo = {
        version: result.updateInfo.version,
        body,
        date: result.updateInfo.releaseDate ?? null,
        downloaded: false,
      };
    }
    return cachedUpdateInfo;
  } catch (err) {
    console.error('[updater] checkForUpdates failed:', err);
    return cachedUpdateInfo;
  }
}

export function registerUpdaterHandlers(): void {
  // ── check_for_updates ──────────────────────────────────────────────
  // Returns cached state only — no API call. Eliminates double-check race.
  ipcMain.handle('check_for_updates', async () => {
    return cachedUpdateInfo;
  });

  // ── force_check_for_updates ────────────────────────────────────────
  // Bypasses cache and hits GitHub API. Used by Help > Check for Updates.
  ipcMain.handle('force_check_for_updates', async () => {
    // Reset cache so we get fresh data
    cachedUpdateInfo = null;
    return doUpdateCheck();
  });

  // ── updater_get_channel ────────────────────────────────────────────
  ipcMain.handle('updater_get_channel', () => {
    const version = app.getVersion();
    return { betaUpdates: betaUpdatesEnabled(), version, isPrerelease: isPrereleaseVersion(version) };
  });

  // ── updater_set_beta_updates ───────────────────────────────────────
  // Acts at once (not part of the Settings Save button) and returns a fresh check on the new channel.
  ipcMain.handle('updater_set_beta_updates', async (_e, args: { enabled?: unknown } | undefined) => {
    if (typeof args?.enabled !== 'boolean') throw new Error('Invalid beta updates value');
    writeSettings({ ...readSettings(), beta_updates: args.enabled });
    const updater = await getAutoUpdater();
    if (updater) applyUpdateChannel(updater, args.enabled);
    if (!args.enabled && gate?.clearIfBlocked()) dropBlockedUpdate();
    return freshUpdateCheck();
  });

  // ── download_and_install_update ────────────────────────────────────
  // Fallback for manual retry — auto-download handles the normal path
  ipcMain.handle('download_and_install_update', async () => {
    if (downloadedVersion) return; // Already downloaded

    const updater = await getAutoUpdater();
    if (!updater) {
      throw new Error('Auto-updater is not available');
    }
    if (gate?.isBlocked(gate.offeredVersion)) throw new Error(BETA_OFF_MESSAGE);

    try {
      await updater.downloadUpdate();
      // update-downloaded event listener handles the rest
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed';
      const win = AppState.getInstance().getMainWindow();
      win?.webContents.send('update:error', { message });
      throw err;
    }
  });

  // ── install_update ─────────────────────────────────────────────────
  // Called when user explicitly clicks "Restart Now"
  ipcMain.handle('install_update', async () => {
    const updater = await getAutoUpdater();
    if (!updater) {
      throw new Error('Auto-updater is not available');
    }
    if (!downloadedVersion || !gate) {
      throw new Error('No update has been downloaded');
    }
    if (!gate.canInstall()) throw new Error(BETA_OFF_MESSAGE);

    // Signal that the app is intentionally quitting so the window close handler
    // doesn't preventDefault() and hide the window (close-to-tray behavior).
    setIsQuitting(true);
    await installAfterVaultFlush({
      flushVault: () => appQuitFlush().flushNow(),
      quitAndInstall: () => updater.quitAndInstall(false, true),
      // Safety net: quitAndInstall() calls app.quit() via setImmediate internally,
      // but on macOS the process can survive if the tray icon or the empty
      // window-all-closed handler keeps it alive. Force-quit after a short delay
      // to ensure the update actually installs and the app relaunches.
      scheduleForceQuit: () => {
        setTimeout(() => {
          app.quit();
        }, 1500);
      },
      onFailed: (vaultFlushed, err) => {
        console.error('[updater] quitAndInstall failed:', err instanceof Error ? err.message : err);
        setIsQuitting(false);
        appQuitFlush().reset();
        const win = AppState.getInstance().getMainWindow();
        if (vaultFlushed) win?.webContents.send('vault-locked-by-system');
        win?.webContents.send('update:error', {
          message: 'Installation failed. Please download the update manually.',
        });
        const config = getEnvConfig();
        shell.openExternal(`${config.websiteUrl}/download`);
      },
    });
  });
}

/** Called from main.ts on app ready to silently check for updates + start periodic checks. */
export async function setupAutoUpdater(): Promise<void> {
  const updater = await getAutoUpdater();
  if (!updater) return;

  // Allow update checks in dev mode when dev-app-update.yml exists
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  applyUpdateChannel(updater, betaUpdatesEnabled());

  // Attach global error listener once
  updater.on('error', (err) => {
    console.error('[updater] Error:', err?.message);
    const win = AppState.getInstance().getMainWindow();
    win?.webContents.send('update:error', {
      message: err?.message ?? 'Update error',
    });
  });

  // Listen for update-available (fires when checkForUpdates finds a new version)
  updater.on('update-available', (info) => {
    if (gate && !gate.offer(info.version)) return;
    const notes = info.releaseNotes;
    let body: string | null = null;
    if (typeof notes === 'string') {
      body = stripHtml(notes);
    } else if (Array.isArray(notes)) {
      body = notes.map((n: string | { note?: string | null }) => (typeof n === 'string' ? stripHtml(n) : stripHtml(n.note ?? ''))).join('\n');
    }
    cachedUpdateInfo = { version: info.version, body, date: info.releaseDate ?? null, downloaded: false };
    const win = AppState.getInstance().getMainWindow();
    win?.webContents.send('update:available', { version: info.version, body, date: info.releaseDate ?? null });
  });

  // Listen for download-progress (fires during auto-download)
  updater.on('download-progress', (progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => {
    if (gate && !gate.progressVisible()) return;
    const win = AppState.getInstance().getMainWindow();
    win?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  // Listen for completed download (auto or manual)
  updater.on('update-downloaded', (info) => {
    if (gate && !gate.downloaded(info.version)) {
      dropBlockedUpdate();
      return;
    }
    downloadedVersion = info.version;
    if (cachedUpdateInfo) {
      cachedUpdateInfo = { ...cachedUpdateInfo, downloaded: true };
    }
    const win = AppState.getInstance().getMainWindow();
    win?.webContents.send('update:downloaded', { version: info.version });
    app.emit(MENU_REFRESH_EVENT);
  });

  // Initial check (non-blocking) — auto-download kicks in automatically
  await doUpdateCheck();

  // Periodic checks every 4 hours
  periodicCheckTimer = setInterval(() => {
    doUpdateCheck().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

/** Stop periodic update checks (called on app quit). */
export function stopPeriodicUpdateChecks(): void {
  if (periodicCheckTimer) {
    clearInterval(periodicCheckTimer);
    periodicCheckTimer = null;
  }
}
