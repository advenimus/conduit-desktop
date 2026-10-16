import { isPrereleaseVersion } from './update-channel.js';

/** The part of electron-updater's AppUpdater the gate drives. */
export interface PendingUpdateTarget {
  autoInstallOnAppQuit: boolean;
}

export interface DownloadCancel {
  cancel(): void;
}

export interface PendingUpdateGate {
  /** A prerelease while beta updates are off. */
  isBlocked(version: string | null): boolean;
  /** On update-available. True when the update should be shown. */
  offer(version: string): boolean;
  /** After checkForUpdates starts the auto-download. Cancels it at once when blocked, and returns true. */
  track(version: string, token: DownloadCancel | undefined, download: Promise<unknown> | null | undefined): boolean;
  /** On update-downloaded. True when it may install. */
  downloaded(version: string): boolean;
  progressVisible(): boolean;
  /** When beta updates turn off. True when a beta was dropped. */
  clearIfBlocked(): boolean;
  canInstall(): boolean;
  readonly offeredVersion: string | null;
  readonly downloadedVersion: string | null;
}

/** Keeps a beta from installing once beta updates are off; reads betaEnabled() at every step (docs/BETA_CHANNEL.md). */
export function createPendingUpdateGate(updater: PendingUpdateTarget, betaEnabled: () => boolean): PendingUpdateGate {
  let offered: string | null = null;
  let download: DownloadCancel | null = null;
  let downloadedVersion: string | null = null;

  const isBlocked = (version: string | null): boolean =>
    version !== null && !betaEnabled() && isPrereleaseVersion(version);

  const dropPending = () => {
    download?.cancel();
    download = null;
    updater.autoInstallOnAppQuit = false;
    // A cancelled download also empties electron-updater's pending cache, so an earlier file is gone too.
    downloadedVersion = null;
  };

  return {
    isBlocked,
    offer(version) {
      offered = version;
      return !isBlocked(version);
    },
    track(version, token, pending) {
      // Errors already reach the 'error' event; a cancelled download rejects quietly.
      pending?.catch(() => {});
      download = token ?? null;
      if (!isBlocked(version)) return false;
      dropPending();
      return true;
    },
    downloaded(version) {
      download = null;
      // Runs inside the update-downloaded emit: MacUpdater reads the flag right after, BaseUpdater at quit.
      if (isBlocked(version)) {
        updater.autoInstallOnAppQuit = false;
        downloadedVersion = null;
        return false;
      }
      updater.autoInstallOnAppQuit = true;
      downloadedVersion = version;
      return true;
    },
    progressVisible() {
      return !isBlocked(offered);
    },
    clearIfBlocked() {
      if (!isBlocked(offered) && !isBlocked(downloadedVersion)) return false;
      dropPending();
      return true;
    },
    canInstall() {
      return downloadedVersion !== null && !isBlocked(downloadedVersion);
    },
    get offeredVersion() {
      return offered;
    },
    get downloadedVersion() {
      return downloadedVersion;
    },
  };
}
