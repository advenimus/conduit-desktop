/**
 * What every personal unlock does after the vault opened: chat store,
 * recent vaults, backups, biometric key migration. Backups of a vault the sync engine manages
 * read a snapshot of its working copy and never start the legacy file watcher; a vault opened
 * in place keeps the watcher and reload as before. Also the access handlers the sync manager
 * calls (soft lock, open or create in place).
 */

import path from 'node:path';
import type { AppState } from '../services/state.js';
import type { VaultMutation } from '../services/vault/vault.js';
import { NetworkVaultWatcher } from '../services/vault/network-watcher.js';
import { cloudBackupPlanAllows } from '../services/vault/cloud-backup-plan.js';
import type { SnapshotWriter } from '../services/vault/backup-snapshot.js';
import { migrateBiometricKey } from './biometric-lineage.js';
import { softLockPersonalVault } from './vault-lock-flow.js';
import { readSettings, updateLastVaultContext, updateRecentVaults } from './settings.js';

const WATCHER_RELOAD_DEBOUNCE_MS = 1000;
const WRITE_LOCK_RELEASE_MS = 500;
const VAULT_MISMATCH_MESSAGE = 'The vault to open is not the selected vault file.';

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/**
 * Compose all active backup mutation listeners into a single callback.
 * Call this whenever cloud sync or local backup is enabled/disabled.
 */
export function rebuildMutationCallback(state: AppState): void {
  const callbacks: ((mutation: VaultMutation) => void)[] = [];

  if (state.cloudSync.getState().enabled) {
    callbacks.push(() => state.cloudSync.notifyMutation());
  }

  if (state.localBackup.getState().enabled) {
    callbacks.push(() => state.localBackup.notifyMutation());
  }

  state.vault.setOnMutation(
    callbacks.length > 0 || state.vaultWatcher
      ? (mutation) => {
          // Suppress file watcher during our own writes
          state.vaultWatcher?.setWriteLock(true);
          callbacks.forEach((cb) => cb(mutation));
          setTimeout(() => state.vaultWatcher?.setWriteLock(false), WRITE_LOCK_RELEASE_MS);
        }
      : null,
  );
}

/** Vaults opened in place: reload when another app rewrites the file (iCloud Drive, shares). */
function startVaultWatcher(state: AppState): void {
  state.vaultWatcher?.stop();

  const vaultPath = state.vault.getFilePath();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  console.log(`[vault-watcher] Starting watcher for: ${vaultPath}`);
  state.vaultWatcher = new NetworkVaultWatcher(vaultPath, () => {
    // iCloud sync can fire several change events in a row.
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      console.log('[vault-watcher] External change detected, reloading from disk');
      state.vault.reloadFromDisk();
      const win = state.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('vault:entry-changed');
      }
    }, WATCHER_RELOAD_DEBOUNCE_MS);
  });
  state.vaultWatcher.start();
}

function ensureVaultId(state: AppState): void {
  try {
    state.vault.getVaultId();
  } catch (err) {
    console.warn('[vault] could not read or create the vault id', { name: errName(err) });
  }
}

function configureLocalBackup(state: AppState, masterPassword: string, snapshot: SnapshotWriter | undefined): void {
  try {
    const settings = readSettings();
    if (settings.local_backup_enabled && settings.local_backup_path) {
      state.localBackup.configure({
        masterPassword,
        vaultPath: state.currentVaultPath,
        enabled: true,
        backupPath: settings.local_backup_path,
        retentionDays: settings.local_backup_retention_days,
        snapshot,
      });
    }
  } catch (err) {
    console.warn('[vault] Failed to configure local backup:', err);
  }
}

function configureCloudBackup(state: AppState, masterPassword: string, snapshot: SnapshotWriter | undefined): void {
  const authState = state.authService.getAuthState();
  if (!authState.isAuthenticated || !authState.user) return;
  if (!state.vault.isCloudSyncEnabled()) return;
  if (!cloudBackupPlanAllows(authState, readSettings(), Date.now())) {
    console.info('[vault] cloud backup stays off: the plan does not include it');
    state.cloudSync.disable();
    return;
  }
  state.cloudSync.configure({
    userId: authState.user.id,
    vaultId: state.vault.getVaultId(),
    masterPassword,
    vaultPath: state.currentVaultPath,
    enabled: true,
    snapshot,
  });
}

/** After vault is unlocked, configure backup services if enabled. */
export function wireBackupServices(state: AppState, masterPassword: string): void {
  state.currentMasterPassword = masterPassword;
  ensureVaultId(state);
  const engine = state.appSync.isEngineManaged();
  const snapshot: SnapshotWriter | undefined = engine ? (target) => state.appSync.snapshotForBackup(target) : undefined;
  configureLocalBackup(state, masterPassword, snapshot);
  configureCloudBackup(state, masterPassword, snapshot);
  // The sync engine watches shared files itself and merges instead of reloading.
  if (!engine) startVaultWatcher(state);
  rebuildMutationCallback(state);
}

/**
 * Chat history is a side store keyed by the vault password: a store it cannot open (another
 * vault's password, or a password changed on another device) stays locked instead of failing
 * the unlock.
 */
function unlockChatStore(state: AppState, password: string, previousPassword: string | null): void {
  const chat = state.chatStore;
  try {
    if (!chat.exists()) chat.initialize(password);
    else chat.unlock(password);
    return;
  } catch (err) {
    if (previousPassword === null) {
      console.warn('[vault] chat store stays locked: it does not open with this vault password', { name: errName(err) });
      return;
    }
  }
  try {
    chat.unlock(previousPassword);
    chat.changePassword(previousPassword, password);
  } catch (err) {
    console.warn('[vault] chat store stays locked after the password change', { name: errName(err) });
  }
}

/** The shared tail of every personal unlock path. */
export function completePersonalUnlock(state: AppState, password: string, lineageId: string, previousPassword: string | null = null): void {
  unlockChatStore(state, password, previousPassword);
  updateRecentVaults(state.currentVaultPath);
  updateLastVaultContext('personal');
  wireBackupServices(state, password);
  state.personalLockReason = null;
  migrateBiometricKey(state.currentVaultPath, lineageId);
}

function requireSelectedVault(state: AppState, vaultPath: string): void {
  if (path.resolve(state.vault.getFilePath()) !== path.resolve(vaultPath)) {
    console.error('[vault] open in place refused: the path is not the selected vault');
    throw new Error(VAULT_MISMATCH_MESSAGE);
  }
}

/** The handlers behind AppState.vaultAccess (the sync manager's VaultAccessHost). */
export function installVaultAccessHandlers(state: AppState): void {
  state.vaultAccess.set({
    blockAccess: (reason) => state.vault.blockAccess(reason),
    softLock: (reason) => softLockPersonalVault(state, reason),
    openPrivateInPlace: async (vaultPath, password) => {
      requireSelectedVault(state, vaultPath);
      state.vault.unlock(password);
    },
    createPrivateInPlace: async (vaultPath, password) => {
      requireSelectedVault(state, vaultPath);
      state.vault.initialize(password);
    },
  });
}
