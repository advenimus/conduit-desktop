/**
 * IPC handlers for biometric (Touch ID / Windows Hello) vault unlock.
 *
 * Manages storing and retrieving the master password behind a biometric gate, keyed by the
 * vault lineage (legacy entries keyed by the vault path still work and move on first unlock).
 * The biometric_unlock handler runs the same personal unlock as vault_unlock with the stored
 * password: biometric prompt, then open (lease, working copy, engine), then the common tail.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { getBiometricService } from '../services/vault/biometric.js';
import { PersonalVaultOpenError } from '../services/vault-session/open-errors.js';
import { readSettings, writeSettings } from './settings.js';
import {
  currentBiometricKey,
  enabledKey,
  isBiometricEnabledForPath,
  removeBiometricForPath,
  resolveBiometricKeys,
} from './biometric-lineage.js';
import { openPersonalAndFinish, parseUnlockOptions } from './vault-unlock.js';

const UNLOCK_REASON = 'Unlock your Conduit vault';

function record(args: unknown): Readonly<Record<string, unknown>> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function requireVaultPath(args: unknown): string {
  const v = record(args).vaultPath;
  if (typeof v !== 'string' || v === '') throw new Error('Choose a vault file first');
  return v;
}

/** The stored password was superseded by a change on another device: its entry is useless now. */
function isSupersededBiometric(err: unknown): boolean {
  return err instanceof PersonalVaultOpenError && err.payload.code === 'VAULT_PASSWORD_CHANGED_ELSEWHERE' && err.payload.deleteBiometric;
}

export function registerBiometricHandlers(): void {
  const state = AppState.getInstance();
  const biometric = getBiometricService();

  /** Check if biometric hardware is available on this platform. */
  ipcMain.handle('biometric_available', async () => {
    return biometric.isAvailable();
  });

  /** Check if biometric unlock is enabled for the current vault. */
  ipcMain.handle('biometric_enabled', async () => {
    return isBiometricEnabledForPath(state, state.currentVaultPath);
  });

  /** Check if biometric unlock is enabled for a specific vault path (pre-unlock). */
  ipcMain.handle('biometric_enabled_for_path', async (_e, args) => {
    const vaultPath = record(args).vaultPath;
    if (typeof vaultPath !== 'string' || vaultPath === '') return false;
    return isBiometricEnabledForPath(state, vaultPath);
  });

  /**
   * Enable biometric unlock for the current vault.
   * Must be called while the vault is unlocked (master password available).
   */
  ipcMain.handle('biometric_enable', async () => {
    const password = state.currentMasterPassword;
    if (!state.vault.isUnlocked() || !password) {
      throw new Error('Vault must be unlocked to enable biometric');
    }
    await biometric.storePassword(await currentBiometricKey(state), password);
  });

  /** Disable biometric unlock for the current vault. */
  ipcMain.handle('biometric_disable', async () => {
    await removeBiometricForPath(state, state.currentVaultPath);
  });

  /**
   * Perform biometric unlock: prompt, retrieve password, full personal unlock.
   * Optional args: takeover (open here instead), previousPassword (password changed elsewhere).
   */
  ipcMain.handle('biometric_unlock', async (_e, args) => {
    const vaultPath = state.currentVaultPath;
    const keys = await resolveBiometricKeys(state, vaultPath);
    // Nothing stored: the service raises its own message (not stored, or not supported here).
    const key = enabledKey(keys) ?? keys.lineageKey ?? keys.pathKey;
    const masterPassword = await biometric.retrievePassword(key, UNLOCK_REASON);
    const opts = parseUnlockOptions(args);
    const request = {
      path: vaultPath,
      password: masterPassword,
      previousPassword: opts.previousPassword,
      takeover: opts.takeover,
      recoverWorkingCopy: opts.recoverWorkingCopy,
      source: 'biometric_unlock' as const,
    };
    await openPersonalAndFinish(state, request, async (err) => {
      if (!isSupersededBiometric(err)) return;
      await removeBiometricForPath(state, vaultPath);
      console.info('[vault] removed a biometric entry superseded by a password change elsewhere');
    });
  });

  /**
   * Remove biometric data for a specific vault path.
   * Called when removing a vault from recents.
   */
  ipcMain.handle('biometric_remove_for_path', async (_e, args) => {
    await removeBiometricForPath(state, requireVaultPath(args));
  });

  /**
   * Check whether the setup prompt was dismissed for the current vault.
   * Returns true if the user should be prompted (not dismissed, not already enabled).
   */
  ipcMain.handle('biometric_should_prompt', async () => {
    const keys = await resolveBiometricKeys(state, state.currentVaultPath);
    if (enabledKey(keys) !== null) return false;
    const dismissed = readSettings().biometric_dismissed_vaults ?? [];
    return !dismissed.includes(keys.pathKey) && (keys.lineageKey === null || !dismissed.includes(keys.lineageKey));
  });

  /**
   * Mark the setup prompt as dismissed for the current vault.
   * Called when user taps "Not Now" on the setup prompt.
   */
  ipcMain.handle('biometric_dismiss_prompt', async () => {
    const key = await currentBiometricKey(state);
    const settings = readSettings();
    const dismissed = settings.biometric_dismissed_vaults ?? [];
    if (!dismissed.includes(key)) {
      settings.biometric_dismissed_vaults = [...dismissed, key];
      writeSettings(settings);
    }
  });
}
