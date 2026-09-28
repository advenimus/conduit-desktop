/**
 * Electron side of the optional idle auto-lock (services/vault/idle-lock.ts): powerMonitor idle
 * time and screen lock, the settings value, and the same lock plus renderer notice the tray
 * hide path uses.
 */

import { powerMonitor, type BrowserWindow } from 'electron';
import { AppState } from '../services/state.js';
import { idleLockMinutes, type RawSettings } from '../services/sync/host-electron-settings.js';
import { startIdleLock } from '../services/vault/idle-lock.js';
import { lockVaultFromMain } from './vault.js';
import { readSettings } from './settings.js';

const LOCKED_BY_SYSTEM_EVENT = 'vault-locked-by-system';

/** Starts the idle checks; returns the stop function for before-quit. */
export function startVaultIdleLock(getMainWindow: () => BrowserWindow | null): () => void {
  const state = AppState.getInstance();
  return startIdleLock({
    minutes: () => idleLockMinutes(readSettings() as unknown as RawSettings),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    canLock: () => state.vault.isUnlocked() && state.teamVaultManager.getActiveVault() === null,
    lock: async () => {
      await lockVaultFromMain();
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(LOCKED_BY_SYSTEM_EVENT);
    },
    onLockScreen: (listener) => {
      powerMonitor.on('lock-screen', listener);
      return () => {
        powerMonitor.removeListener('lock-screen', listener);
      };
    },
  });
}
