/**
 * Beta update channel logic (docs/BETA_CHANNEL.md). Pure, so the renderer can share it.
 */

const PRERELEASE_VERSION = /^v?\d+\.\d+\.\d+-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*(\+[0-9A-Za-z.-]+)?$/;

export interface UpdateChannelTarget {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

export function isPrereleaseVersion(version: string): boolean {
  return PRERELEASE_VERSION.test(version);
}

/** A saved choice wins; with none saved, a beta build gets beta updates. */
export function getEffectiveBetaUpdates(setting: boolean | undefined, version: string): boolean {
  return typeof setting === 'boolean' ? setting : isPrereleaseVersion(version);
}

/**
 * Sets both flags every time: electron-updater turns allowPrerelease on by itself for a beta build.
 * Never sets `channel`, which would also allow downgrades and look for files GitHub releases lack.
 */
export function applyUpdateChannel(updater: UpdateChannelTarget, enabled: boolean): void {
  updater.allowPrerelease = enabled;
  updater.allowDowngrade = false;
}
