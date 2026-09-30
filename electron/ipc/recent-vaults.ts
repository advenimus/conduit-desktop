/**
 * Removing vaults from the recent list, with their stored biometric passwords. Entries are keyed
 * by vault lineage, with the legacy path key as fallback (spec 5.9), so removing one vault drops
 * both keys; clearing the list drops every stored entry.
 */

import type { AppSettings } from './settings.js';

type RecentFields = Pick<AppSettings, 'recent_vaults' | 'last_vault_path'>;

export interface RecentVaultDeps<S extends RecentFields> {
  read(): S;
  write(settings: S): void;
  /** biometric-lineage removeBiometricForPath: the lineage key and the path key. */
  removeBiometric(vaultPath: string): Promise<void>;
  removeAllBiometric(): void;
}

const LOG = '[settings]';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export function withoutRecentVault<S extends RecentFields>(settings: S, vaultPath: string): S {
  const recent = settings.recent_vaults.filter((p) => p !== vaultPath);
  const last = settings.last_vault_path === vaultPath ? (recent[0] ?? null) : settings.last_vault_path;
  return { ...settings, recent_vaults: recent, last_vault_path: last };
}

/** The vault file at `from` is now at `to` (spec 5.9): it keeps its place in the list, listed once. */
export function withMovedRecentVault<S extends RecentFields>(settings: S, from: string, to: string): S {
  if (!settings.recent_vaults.includes(from) && settings.last_vault_path !== from) return settings;
  const mapped = settings.recent_vaults.map((p) => (p === from ? to : p));
  const recent = mapped.filter((p, i) => p !== to || mapped.indexOf(to) === i);
  const last = settings.last_vault_path === from ? to : settings.last_vault_path;
  return { ...settings, recent_vaults: recent, last_vault_path: last };
}

/** Returns the new recent list. A failed biometric cleanup is logged and never fails the removal. */
export async function removeRecentVault<S extends RecentFields>(deps: RecentVaultDeps<S>, vaultPath: string): Promise<string[]> {
  const next = withoutRecentVault(deps.read(), vaultPath);
  deps.write(next);
  try {
    await deps.removeBiometric(vaultPath);
  } catch (err) {
    console.warn(`${LOG} biometric cleanup for a removed vault failed`, { name: errName(err) });
  }
  return next.recent_vaults;
}

export function clearRecentVaults<S extends RecentFields>(deps: RecentVaultDeps<S>): string[] {
  const next = { ...deps.read(), recent_vaults: [], last_vault_path: null };
  deps.write(next);
  try {
    deps.removeAllBiometric();
  } catch (err) {
    console.warn(`${LOG} biometric cleanup after clearing recent vaults failed`, { name: errName(err) });
  }
  return next.recent_vaults;
}
