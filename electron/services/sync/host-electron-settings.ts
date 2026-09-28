/**
 * Typed reads of the settings.json fields the sync and session hosts use (spec 5.5 upgrade
 * wording, 5.11 on/off setting, 6.8 tier cache, 8.1 kill switch). Settings arrive as a raw record so
 * these readers work whether or not AppSettings declares the newer fields yet; every field is
 * validated and a bad value falls back to the default.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Raw settings.json object (ipc/settings.ts readSettings()). */
export type RawSettings = Readonly<Record<string, unknown>>;

export interface SettingsSource {
  read(): RawSettings;
}

/** settings.json key of multi-device sync on this device (absent means on; no UI). */
export const PERSONAL_SYNC_SETTING = 'personal_sync_enabled';
/** settings.json key of the optional idle auto-lock, in minutes (absent or 0 means off). */
export const IDLE_LOCK_SETTING = 'vault_idle_lock_minutes';

const CASE_INSENSITIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** Missing or malformed reads as on (the engine is on by default). */
export function personalSyncEnabled(s: RawSettings): boolean {
  return s[PERSONAL_SYNC_SETTING] !== false;
}

/** Idle auto-lock minutes; 0 when off or malformed. */
export function idleLockMinutes(s: RawSettings): number {
  const v = s[IDLE_LOCK_SETTING];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/** cached_tier_capabilities as a record, or null. */
export function cachedTierCapabilities(s: RawSettings): Readonly<Record<string, unknown>> | null {
  const caps = s.cached_tier_capabilities;
  return isRecord(caps) ? caps : null;
}

/** cached_tier_timestamp in ms, or null when absent or unparsable. */
export function cachedTierTimestampMs(s: RawSettings): number | null {
  const ts = s.cached_tier_timestamp;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Vault paths this device's settings name (last_vault_path, then recent_vaults). */
export function listedVaultPaths(s: RawSettings): readonly string[] {
  const last = typeof s.last_vault_path === 'string' && s.last_vault_path !== '' ? [s.last_vault_path] : [];
  return [...last, ...stringList(s.recent_vaults)];
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Path equality after realpath, with the platform's case folding. */
export function sameRealpath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = CASE_INSENSITIVE.has(platform) ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(realpathOrSelf(a)) === fold(realpathOrSelf(b));
}
