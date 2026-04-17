/**
 * IPC handlers for the credential vault.
 *
 * Supports both the new unified vault and legacy credential operations.
 */

import { ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';
import type { VaultMutation } from '../services/vault/vault.js';
import { migrateToConduit } from '../services/vault/migration.js';
import { NetworkVaultWatcher } from '../services/vault/network-watcher.js';
import { updateRecentVaults, readSettings, writeSettings, updateLastVaultContext } from './settings.js';

/**
 * Compose all active backup mutation listeners into a single callback.
 * Call this whenever cloud sync or local backup is enabled/disabled.
 *
 * The mutation callback receives structured mutation data (type, action, id, name)
 * which can be used by team sync and audit services. Existing services (cloud sync,
 * local backup) only need to know "something changed" and ignore the mutation details.
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
          setTimeout(() => state.vaultWatcher?.setWriteLock(false), 500);
        }
      : null,
  );
}

/** Start watching the vault file for external changes (e.g. iCloud Drive sync from mobile). */
function startVaultWatcher(state: AppState): void {
  // Stop any existing watcher
  state.vaultWatcher?.stop();

  const vaultPath = state.vault.getFilePath();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  console.log(`[vault-watcher] Starting watcher for: ${vaultPath}`);
  state.vaultWatcher = new NetworkVaultWatcher(vaultPath, () => {
    // Debounce: iCloud sync can fire multiple rapid change events.
    // Wait 1s after the last event before reloading.
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      console.log('[vault-watcher] External change detected, reloading from disk');
      state.vault.reloadFromDisk();
      const win = state.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('vault:entry-changed');
      }
    }, 1000);
  });
  state.vaultWatcher.start();
}

/** After vault is unlocked, configure backup services if enabled. */
export function wireBackupServices(state: AppState, masterPassword: string): void {
  state.currentMasterPassword = masterPassword;

  // Configure local backup from settings (no auth required)
  try {
    const settings = readSettings();
    if (settings.local_backup_enabled && settings.local_backup_path) {
      state.localBackup.configure({
        masterPassword,
        vaultPath: state.currentVaultPath,
        chatDbPath: state.chatStore.getDbPath(),
        enabled: true,
        backupPath: settings.local_backup_path,
        retentionDays: settings.local_backup_retention_days,
        includeChat: settings.local_backup_include_chat,
      });
    }
  } catch (err) {
    console.warn('[vault] Failed to configure local backup:', err);
  }

  const authState = state.authService.getAuthState();
  if (!authState.isAuthenticated || !authState.user) {
    // Still start file watcher and rebuild mutation callback for local backup
    startVaultWatcher(state);
    rebuildMutationCallback(state);
    return;
  }

  const cloudEnabled = state.vault.isCloudSyncEnabled();
  if (cloudEnabled) {
    state.cloudSync.configure({
      userId: authState.user.id,
      vaultId: state.vault.getVaultId(),
      masterPassword,
      vaultPath: state.currentVaultPath,
      enabled: true,
    });
  }

  // Rebuild after all services configured
  rebuildMutationCallback(state);

  // Wire chat cloud sync if enabled
  const chatCloudEnabled = state.vault.isChatCloudSyncEnabled();
  if (chatCloudEnabled) {
    state.chatCloudSync.configure({
      chatStore: state.chatStore,
      masterPassword,
      enabled: true,
    });
    // Engine conversations call state.chatCloudSync.notifyMutation directly
    // in electron/ipc/engine.ts when they mutate the chat store.
    // Run full sync in background (don't await)
    state.chatCloudSync.fullSync().catch((err) => {
      console.error('[vault] Chat cloud sync initial sync failed:', err);
    });
  }

  // Start watching for external file changes (iCloud Drive, network shares)
  startVaultWatcher(state);
  // Rebuild mutation callback again to include watcher write-lock suppression
  rebuildMutationCallback(state);
}

/** On vault lock, clear all backup service state. */
export function teardownBackupServices(state: AppState): void {
  state.currentMasterPassword = null;
  state.vaultWatcher?.stop();
  state.vaultWatcher = null;
  state.cloudSync.disable();
  state.localBackup.disable();
  state.chatCloudSync.disable();
  state.vault.setOnMutation(null);
}

/** Lock the vault from the main process (no IPC round-trip needed). */
export async function lockVaultFromMain(): Promise<void> {
  const state = AppState.getInstance();
  if (!state.vault.isUnlocked()) return;
  await state.closeAllSessions();
  teardownBackupServices(state);
  state.chatStore.lock();
  state.vault.lock();
}

export function registerVaultHandlers(): void {
  const state = AppState.getInstance();

  // ── Vault lifecycle ──────────────────────────────────────────────

  ipcMain.handle('vault_initialize', async (_e, args) => {
    const { masterPassword } = args as { masterPassword: string };
    state.vault.initialize(masterPassword);
    // Initialize chat store alongside vault
    state.chatStore.initialize(masterPassword);
    updateRecentVaults(state.currentVaultPath);
    updateLastVaultContext('personal');

    wireBackupServices(state, masterPassword);
  });

  ipcMain.handle('vault_unlock', async (_e, args) => {
    const { masterPassword } = args as { masterPassword: string };
    state.vault.unlock(masterPassword);
    // Unlock or initialize chat store
    if (state.chatStore.exists()) {
      state.chatStore.unlock(masterPassword);
    } else {
      state.chatStore.initialize(masterPassword);
    }
    updateRecentVaults(state.currentVaultPath);
    updateLastVaultContext('personal');

    wireBackupServices(state, masterPassword);
  });

  ipcMain.handle('vault_lock', async () => {
    await lockVaultFromMain();
  });

  ipcMain.handle('vault_is_unlocked', async () => {
    return state.vault.isUnlocked();
  });

  ipcMain.handle('vault_exists', async () => {
    return state.vault.exists();
  });

  ipcMain.handle('vault_save', async () => {
    state.vault.save();
  });

  ipcMain.handle('vault_get_type', async () => {
    return state.teamVaultManager.getActiveVaultId() ? 'team' : 'personal';
  });

  // ── New vault management ─────────────────────────────────────────

  ipcMain.handle('vault_get_path', async () => {
    return state.currentVaultPath;
  });

  ipcMain.handle('vault_create', async (_e, args: { filePath: string; masterPassword: string }) => {
    await state.closeAllSessions();
    state.switchVault(args.filePath);
    state.vault.initialize(args.masterPassword);
    updateRecentVaults(args.filePath);
    return args.filePath;
  });

  ipcMain.handle('vault_open', async (_e, args: { filePath: string }) => {
    await state.closeAllSessions();
    state.switchVault(args.filePath);
    updateRecentVaults(args.filePath);
    const exists = state.vault.exists();
    return { filePath: args.filePath, exists };
  });

  ipcMain.handle('vault_rename', async (_e, args: { newName: string }) => {
    if (!state.vault.isUnlocked()) {
      throw new Error('Vault must be unlocked to rename');
    }
    if (state.teamVaultManager.getActiveVault()) {
      throw new Error('Cannot rename a team vault from here');
    }

    const masterPassword = state.currentMasterPassword;
    if (!masterPassword) {
      throw new Error('Master password not available');
    }

    // Sanitize: strip .conduit suffix, path separators, and trim
    const sanitized = args.newName.replace(/\.conduit$/i, '').replace(/[/\\]/g, '').trim();
    if (!sanitized) {
      throw new Error('Invalid vault name');
    }

    const oldPath = state.currentVaultPath;
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, `${sanitized}.conduit`);

    if (newPath === oldPath) return oldPath;
    if (fs.existsSync(newPath)) {
      throw new Error(`A vault named "${sanitized}.conduit" already exists in this directory`);
    }

    // Tear down backup services (they hold vaultPath references)
    teardownBackupServices(state);

    // Lock the vault (closes SQLite DB)
    state.vault.lock();

    // Rename files on disk (main + WAL/SHM journal files)
    fs.renameSync(oldPath, newPath);
    for (const suffix of ['-wal', '-shm']) {
      const old = oldPath + suffix;
      if (fs.existsSync(old)) fs.renameSync(old, newPath + suffix);
    }

    // Reopen at the new path and re-unlock
    state.switchVault(newPath);
    state.vault.unlock(masterPassword);

    // Update settings (recent_vaults + last_vault_path)
    const settings = readSettings();
    settings.last_vault_path = newPath;
    settings.recent_vaults = settings.recent_vaults.map((p) => (p === oldPath ? newPath : p));
    writeSettings(settings);

    // Re-wire backup services
    wireBackupServices(state, masterPassword);

    return newPath;
  });

  ipcMain.handle('vault_change_password', async (_e, args: { currentPassword: string; newPassword: string }) => {
    if (!state.vault.isUnlocked()) {
      throw new Error('Vault must be unlocked to change password');
    }
    if (state.teamVaultManager.getActiveVault()) {
      throw new Error('Cannot change password on a team vault');
    }

    // Tear down backup services FIRST to stop any in-flight sync that
    // could interfere with re-encryption (cloud sync, local backup, etc.)
    teardownBackupServices(state);

    // Re-key chat store BEFORE vault — if this fails, nothing has changed
    // yet and the error is clean (vault still uses old password).
    if (state.chatStore.exists() && state.chatStore.isUnlocked()) {
      state.chatStore.changePassword(args.currentPassword, args.newPassword);
    }

    // Change vault password (verifies current, re-encrypts all entries)
    state.vault.changePassword(args.currentPassword, args.newPassword);

    // Re-wire backup services with new password
    wireBackupServices(state, args.newPassword);

    // Update biometric stored password if enabled
    try {
      const { getBiometricService, vaultPathToKey } = await import('../services/vault/biometric.js');
      const biometric = getBiometricService();
      const vaultKey = vaultPathToKey(state.currentVaultPath);
      if (biometric.isEnabledForVault(vaultKey)) {
        await biometric.storePassword(vaultKey, args.newPassword);
      }
    } catch (err) {
      console.warn('[vault] Failed to update biometric password:', err);
    }
  });

  ipcMain.handle('vault_pick_file', async (_e, args: { mode: 'open' | 'save' }) => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    if (args.mode === 'save') {
      const result = await dialog.showSaveDialog(win!, {
        title: 'Create New Vault',
        defaultPath: 'my-vault.conduit',
        filters: [{ name: 'Conduit Vault', extensions: ['conduit'] }],
      });
      return result.canceled ? null : result.filePath;
    } else {
      const result = await dialog.showOpenDialog(win!, {
        title: 'Open Vault',
        filters: [{ name: 'Conduit Vault', extensions: ['conduit'] }],
        properties: ['openFile'],
      });
      return result.canceled ? null : result.filePaths[0];
    }
  });

  // ── Migration ──────────────────────────────────────────────────

  ipcMain.handle('check_legacy_vault_exists', async () => {
    return state.hasLegacyVault();
  });

  ipcMain.handle('migrate_legacy_vault', async (_e, args: { masterPassword: string }) => {
    const dataDir = state.getDataDir();
    const connectionsPath = state.getLegacyConnectionsPath();
    const oldVaultPath = path.join(dataDir, 'vault.db');
    const oldSaltPath = path.join(dataDir, 'vault.salt');
    const newVaultPath = state.getDefaultVaultPath();

    const result = migrateToConduit(
      connectionsPath,
      oldVaultPath,
      oldSaltPath,
      newVaultPath,
      args.masterPassword,
    );

    // Switch to the newly created vault
    state.switchVault(newVaultPath);
    state.vault.unlock(args.masterPassword);
    updateRecentVaults(newVaultPath);

    return result;
  });

  // ── Credential CRUD (legacy compat) ──────────────────────────────

  ipcMain.handle('credential_list', async () => {
    const vault = state.getActiveVault();
    if (!vault.isUnlocked()) return [];
    return vault.listCredentials();
  });

  ipcMain.handle('credential_get', async (_e, args) => {
    const { id } = args as { id: string };
    return state.getActiveVault().getCredential(id);
  });

  ipcMain.handle('credential_create', async (_e, args) => {
    const { name, username, password, domain, private_key, totp_secret, tags, credential_type, public_key, fingerprint, totp_issuer, totp_label, totp_algorithm, totp_digits, totp_period, ssh_auth_method } = args as {
      name: string;
      username?: string | null;
      password?: string | null;
      domain?: string | null;
      private_key?: string | null;
      totp_secret?: string | null;
      tags?: string[];
      credential_type?: string | null;
      public_key?: string | null;
      fingerprint?: string | null;
      totp_issuer?: string | null;
      totp_label?: string | null;
      totp_algorithm?: string | null;
      totp_digits?: number | null;
      totp_period?: number | null;
      ssh_auth_method?: string | null;
    };

    // Build config object from metadata (non-secret data stored in config JSON)
    const config: Record<string, unknown> = {};
    if (public_key) config.public_key = public_key;
    if (fingerprint) config.fingerprint = fingerprint;
    if (totp_issuer) config.totp_issuer = totp_issuer;
    if (totp_label) config.totp_label = totp_label;
    if (totp_algorithm) config.totp_algorithm = totp_algorithm;
    if (totp_digits) config.totp_digits = totp_digits;
    if (totp_period) config.totp_period = totp_period;
    if (ssh_auth_method) config.ssh_auth_method = ssh_auth_method;

    const credential = state.getActiveVault().createCredential({
      name,
      username,
      password,
      domain,
      private_key,
      totp_secret,
      tags: tags ?? [],
      credential_type: credential_type ?? null,
      config: Object.keys(config).length > 0 ? config : undefined,
    });

    return {
      id: credential.id,
      name: credential.name,
      username: credential.username,
      domain: credential.domain,
      tags: credential.tags,
      credential_type: credential.credential_type ?? null,
      created_at: credential.created_at,
    };
  });

  ipcMain.handle('credential_update', async (_e, args) => {
    const { id, name, username, password, domain, private_key, totp_secret, tags, credential_type, public_key, fingerprint, totp_issuer, totp_label, totp_algorithm, totp_digits, totp_period, ssh_auth_method } = args as {
      id: string;
      name?: string;
      username?: string | null;
      password?: string | null;
      domain?: string | null;
      private_key?: string | null;
      totp_secret?: string | null;
      tags?: string[];
      credential_type?: string | null;
      public_key?: string | null;
      fingerprint?: string | null;
      totp_issuer?: string | null;
      totp_label?: string | null;
      totp_algorithm?: string | null;
      totp_digits?: number | null;
      totp_period?: number | null;
      ssh_auth_method?: string | null;
    };

    // Build config update from metadata
    const hasConfigUpdates = public_key !== undefined || fingerprint !== undefined
      || totp_issuer !== undefined || totp_label !== undefined || totp_algorithm !== undefined
      || totp_digits !== undefined || totp_period !== undefined
      || ssh_auth_method !== undefined;

    let config: Record<string, unknown> | undefined;
    if (hasConfigUpdates) {
      // Fetch existing config to merge
      const existing = state.getActiveVault().getCredential(id);
      const existingConfig = (existing as Record<string, unknown>).config as Record<string, unknown> ?? {};
      config = { ...existingConfig };
      if (public_key !== undefined) config.public_key = public_key;
      if (fingerprint !== undefined) config.fingerprint = fingerprint;
      if (totp_issuer !== undefined) config.totp_issuer = totp_issuer || undefined;
      if (totp_label !== undefined) config.totp_label = totp_label || undefined;
      if (totp_algorithm !== undefined) config.totp_algorithm = totp_algorithm || undefined;
      if (totp_digits !== undefined) config.totp_digits = totp_digits || undefined;
      if (totp_period !== undefined) config.totp_period = totp_period || undefined;
      if (ssh_auth_method !== undefined) config.ssh_auth_method = ssh_auth_method || undefined;
    }

    // Record password history if password or username is changing
    let passwordChanging = false;
    let usernameChanging = false;
    try {
      if (password !== undefined || username !== undefined) {
        const existing = state.getActiveVault().getEntry(id);
        passwordChanging = password !== undefined && password !== existing.password;
        usernameChanging = username !== undefined && username !== existing.username;
        if (passwordChanging || usernameChanging) {
          const authState = state.authService?.getAuthState();
          const changedBy = authState?.user?.email ?? null;
          state.getActiveVault().recordPasswordHistory(id, existing.username, existing.password, changedBy);
        }
      }
    } catch {}

    const credential = state.getActiveVault().updateCredential(id, {
      name,
      username,
      password,
      domain,
      private_key,
      totp_secret,
      tags,
      credential_type,
      config,
    });

    if (passwordChanging || usernameChanging) {
      logAudit(state, {
        action: 'password_changed',
        targetType: 'entry',
        targetId: id,
        targetName: credential.name,
        details: {
          fields_changed: [
            ...(passwordChanging ? ['password'] : []),
            ...(usernameChanging ? ['username'] : []),
          ],
        },
      });
    }

    return {
      id: credential.id,
      name: credential.name,
      username: credential.username,
      domain: credential.domain,
      tags: credential.tags,
      credential_type: credential.credential_type ?? null,
      created_at: credential.created_at,
    };
  });

  ipcMain.handle('credential_delete', async (_e, args) => {
    const { id } = args as { id: string };
    state.getActiveVault().deleteCredential(id);
  });

  // ── TOTP QR decoding ────────────────────────────────────────────

  ipcMain.handle('totp_pick_qr_image', async () => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select QR Code Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('totp_decode_qr', async (_e, args: { filePath: string }) => {
    const { decodeQrImage } = await import('../services/vault/totp-qr.js');
    return decodeQrImage(args.filePath);
  });

  // ── Vault locking (Pro plan) ─────────────────────────────────────

  ipcMain.handle('vault_lock_acquire', async (_e, args: { vaultId: string }) => {
    return state.vaultLock.acquireCloudLock(args.vaultId);
  });

  ipcMain.handle('vault_lock_release', async (_e, args?: { vaultId?: string }) => {
    await state.vaultLock.releaseCloudLock(args?.vaultId);
  });

  ipcMain.handle('vault_lock_check', async (_e, args: { vaultId: string }) => {
    return state.vaultLock.checkLock(args.vaultId);
  });

  // ── Network share advisory locking ──────────────────────────────

  ipcMain.handle('vault_network_lock_check', async (_e, args: { vaultPath: string }) => {
    const authState = state.authService.getAuthState();
    const userId = authState.user?.id;
    return state.networkLock.checkLock(args.vaultPath, userId);
  });

  ipcMain.handle('vault_network_lock_acquire', async (_e, args: { vaultPath: string }) => {
    const authState = state.authService.getAuthState();
    if (!authState.user) throw new Error('Not authenticated');
    return state.networkLock.acquireLock(args.vaultPath, authState.user.id);
  });

  ipcMain.handle('vault_network_lock_release', async (_e, args?: { vaultPath?: string }) => {
    state.networkLock.releaseLock(args?.vaultPath);
  });

  ipcMain.handle('vault_is_network_path', async (_e, args: { filePath: string }) => {
    const { NetworkLockService } = await import('../services/vault/network-lock.js');
    return NetworkLockService.isNetworkPath(args.filePath);
  });
}
