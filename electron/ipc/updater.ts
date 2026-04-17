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

let autoUpdater: typeof import('electron-updater').autoUpdater | null = null;

// ── Module-level state ─────────────────────────────────────────────────
interface CachedUpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  downloaded: boolean;
}

let cachedUpdateInfo: CachedUpdateInfo | null = null;
let checkInProgress = false;
let updateDownloaded = false;
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
    autoUpdater = mod.autoUpdater ?? (mod.default as any)?.autoUpdater ?? null;
    return autoUpdater;
  } catch (err) {
    console.error('[updater] Failed to import electron-updater:', err);
    return null;
  }
}

/** Perform an update check, guarded against concurrent calls. */
async function doUpdateCheck(): Promise<CachedUpdateInfo | null> {
  if (checkInProgress) return cachedUpdateInfo;

  const updater = await getAutoUpdater();
  if (!updater) return null;

  checkInProgress = true;
  try {
    const result = await updater.checkForUpdates();
    if (result && (result as any).isUpdateAvailable && result.updateInfo) {
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
  } finally {
    checkInProgress = false;
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

  // ── download_and_install_update ────────────────────────────────────
  // Fallback for manual retry — auto-download handles the normal path
  ipcMain.handle('download_and_install_update', async () => {
    if (updateDownloaded) return; // Already downloaded

    const updater = await getAutoUpdater();
    if (!updater) {
      throw new Error('Auto-updater is not available');
    }

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
    if (!updateDownloaded) {
      throw new Error('No update has been downloaded');
    }

    try {
      // Signal that the app is intentionally quitting so the window close handler
      // doesn't preventDefault() and hide the window (close-to-tray behavior).
      setIsQuitting(true);
      updater.quitAndInstall(false, true);

      // Safety net: quitAndInstall() calls app.quit() via setImmediate internally,
      // but on macOS the process can survive if the tray icon or the empty
      // window-all-closed handler keeps it alive. Force-quit after a short delay
      // to ensure the update actually installs and the app relaunches.
      setTimeout(() => {
        app.quit();
      }, 1500);
    } catch (err) {
      setIsQuitting(false);
      const win = AppState.getInstance().getMainWindow();
      win?.webContents.send('update:error', {
        message: 'Installation failed — please download the update manually.',
      });
      const config = getEnvConfig();
      shell.openExternal(`${config.websiteUrl}/download`);
    }
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
    updateDownloaded = true;
    downloadedVersion = info.version;
    if (cachedUpdateInfo) {
      cachedUpdateInfo = { ...cachedUpdateInfo, downloaded: true };
    }
    const win = AppState.getInstance().getMainWindow();
    win?.webContents.send('update:downloaded', { version: info.version });
    app.emit('conduit:update-downloaded');
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
