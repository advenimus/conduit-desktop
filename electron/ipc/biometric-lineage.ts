/**
 * Biometric entries keyed by vault lineage (spec 5.9). Lookups try the lineage
 * key first and fall back to the legacy path key; the first unlock moves a path-keyed entry to
 * its lineage key. A private vault's lineage follows its salt, so a password change moves the
 * entry to the new lineage key.
 */

import type { AppState } from '../services/state.js';
import { getBiometricService, moveKey, vaultLineageToKey, vaultPathToKey } from '../services/vault/biometric.js';

export interface BiometricKeys {
  readonly lineageKey: string | null;
  readonly pathKey: string;
}

type BiometricState = Pick<AppState, 'appSync' | 'currentVaultPath'>;

const LOG = '[vault]';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export async function resolveBiometricKeys(state: BiometricState, vaultPath: string): Promise<BiometricKeys> {
  const pathKey = vaultPathToKey(vaultPath);
  try {
    const lineage = await state.appSync.lineageForPath(vaultPath);
    return { lineageKey: lineage === null ? null : vaultLineageToKey(lineage), pathKey };
  } catch (err) {
    console.warn(`${LOG} vault lineage lookup failed; using the path key`, { name: errName(err) });
    return { lineageKey: null, pathKey };
  }
}

function keysOf(keys: BiometricKeys): string[] {
  return keys.lineageKey === null ? [keys.pathKey] : [keys.lineageKey, keys.pathKey];
}

/** The stored key for this vault: the lineage key when present, else the path key, else null. */
export function enabledKey(keys: BiometricKeys): string | null {
  const biometric = getBiometricService();
  return keysOf(keys).find((k) => biometric.isEnabledForVault(k)) ?? null;
}

export async function isBiometricEnabledForPath(state: BiometricState, vaultPath: string): Promise<boolean> {
  return enabledKey(await resolveBiometricKeys(state, vaultPath)) !== null;
}

export async function removeBiometricForPath(state: BiometricState, vaultPath: string): Promise<void> {
  const biometric = getBiometricService();
  for (const key of keysOf(await resolveBiometricKeys(state, vaultPath))) biometric.removePassword(key);
}

/** The key new entries use for the current vault: its lineage, else its path. */
export async function currentBiometricKey(state: BiometricState): Promise<string> {
  const keys = await resolveBiometricKeys(state, state.currentVaultPath);
  if (keys.lineageKey !== null) return keys.lineageKey;
  const open = state.appSync.currentLineageId();
  return open === null ? keys.pathKey : vaultLineageToKey(open);
}

/** First unlock after lineage keys: the path-keyed entry moves to the lineage key. Never throws. */
export function migrateBiometricKey(vaultPath: string, lineageId: string): void {
  try {
    moveKey(vaultPathToKey(vaultPath), vaultLineageToKey(lineageId));
  } catch (err) {
    console.warn(`${LOG} biometric key migration failed`, { name: errName(err) });
  }
}

/**
 * After a password change: when biometric unlock was on (`before`), store the new password under
 * the vault's current key and drop the keys that no longer match. Best effort, logged.
 */
export async function restoreBiometricAfterPasswordChange(state: BiometricState, before: BiometricKeys, newPassword: string): Promise<void> {
  if (enabledKey(before) === null) return;
  const biometric = getBiometricService();
  try {
    const target = await currentBiometricKey(state);
    await biometric.storePassword(target, newPassword);
    for (const key of keysOf(before)) if (key !== target) biometric.removePassword(key);
  } catch (err) {
    console.warn(`${LOG} failed to update the biometric password`, { name: errName(err) });
  }
}
