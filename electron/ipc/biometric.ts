/**
 * IPC handlers for biometric (Touch ID / Windows Hello) vault unlock.
 *
 * Manages storing and retrieving the master password behind a biometric gate.
 * The biometric_unlock handler performs the full unlock flow: biometric prompt →
 * retrieve password → vault unlock → chat store unlock → wire backup services.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import { getBiometricService, vaultPathToKey } from '../services/vault/biometric.js';
import { wireBackupServices } from './vault.js';
import { readSettings, writeSettings, updateRecentVaults, updateLastVaultContext } from './settings.js';

export function registerBiometricHandlers(): void {
  const state = AppState.getInstance();
  const biometric = getBiometricService();

  /** Check if biometric hardware is available on this platform. */
  ipcMain.handle('biometric_available', async () => {
    return biometric.isAvailable();
  });

  /** Check if biometric unlock is enabled for the current vault. */
  ipcMain.handle('biometric_enabled', async () => {
    const vaultKey = vaultPathToKey(state.currentVaultPath);
    return biometric.isEnabledForVault(vaultKey);
  });

  /** Check if biometric unlock is enabled for a specific vault path (pre-unlock). */
  ipcMain.handle('biometric_enabled_for_path', async (_e, args: { vaultPath: string }) => {
    const vaultKey = vaultPathToKey(args.vaultPath);
    return biometric.isEnabledForVault(vaultKey);
  });

  /**
   * Enable biometric unlock for the current vault.
   * Must be called while the vault is unlocked (master password available).
   */
  ipcMain.handle('biometric_enable', async () => {
    if (!state.vault.isUnlocked() || !state.currentMasterPassword) {
      throw new Error('Vault must be unlocked to enable biometric');
    }

    const vaultKey = vaultPathToKey(state.currentVaultPath);
    await biometric.storePassword(vaultKey, state.currentMasterPassword);
  });

  /** Disable biometric unlock for the current vault. */
  ipcMain.handle('biometric_disable', async () => {
    const vaultKey = vaultPathToKey(state.currentVaultPath);
    biometric.removePassword(vaultKey);
  });

  /**
   * Perform biometric unlock: prompt → retrieve password → full vault unlock flow.
   * This mirrors the vault_unlock handler but uses the stored biometric password.
   */
  ipcMain.handle('biometric_unlock', async () => {
    const vaultKey = vaultPathToKey(state.currentVaultPath);

    // Prompt biometric + retrieve stored password
    const masterPassword = await biometric.retrievePassword(
      vaultKey,
      'Unlock your Conduit vault',
    );

    // Perform the standard vault unlock
    state.vault.unlock(masterPassword);

    // Unlock or initialize chat store
    if (state.chatStore.exists()) {
      state.chatStore.unlock(masterPassword);
    } else {
      state.chatStore.initialize(masterPassword);
    }

    updateRecentVaults(state.currentVaultPath);
    updateLastVaultContext('personal');

    // Wire backup services (same function used by vault_unlock handler)
    wireBackupServices(state, masterPassword);
  });

  /**
   * Remove biometric data for a specific vault path.
   * Called when removing a vault from recents.
   */
  ipcMain.handle('biometric_remove_for_path', async (_e, args: { vaultPath: string }) => {
    const vaultKey = vaultPathToKey(args.vaultPath);
    biometric.removePassword(vaultKey);
  });

  /**
   * Check whether the setup prompt was dismissed for the current vault.
   * Returns true if the user should be prompted (not dismissed, not already enabled).
   */
  ipcMain.handle('biometric_should_prompt', async () => {
    const vaultKey = vaultPathToKey(state.currentVaultPath);
    if (biometric.isEnabledForVault(vaultKey)) return false;
    const settings = readSettings();
    const dismissed = settings.biometric_dismissed_vaults ?? [];
    return !dismissed.includes(vaultKey);
  });

  /**
   * Mark the setup prompt as dismissed for the current vault.
   * Called when user taps "Not Now" on the setup prompt.
   */
  ipcMain.handle('biometric_dismiss_prompt', async () => {
    const vaultKey = vaultPathToKey(state.currentVaultPath);
    const settings = readSettings();
    const dismissed = settings.biometric_dismissed_vaults ?? [];
    if (!dismissed.includes(vaultKey)) {
      settings.biometric_dismissed_vaults = [...dismissed, vaultKey];
      writeSettings(settings);
    }
  });
}
