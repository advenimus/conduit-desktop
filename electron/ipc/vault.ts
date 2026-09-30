/**
 * IPC handlers for the credential vault.
 *
 * Supports both the new unified vault and legacy credential operations. The personal-vault
 * lifecycle (unlock paths, lock, rename, password change) lives in vault-unlock.ts,
 * vault-manage.ts, vault-wiring.ts and vault-lock-flow.ts; this module registers them.
 */

import path from 'node:path';
import { ipcMain, dialog } from 'electron';
import { AppState } from '../services/state.js';
import { logAudit } from '../services/audit.js';
import { completePersonalUnlock, installVaultAccessHandlers } from './vault-wiring.js';
import { lockPersonalVault } from './vault-lock-flow.js';
import type { LockCause } from './vault-events.js';
import { registerPersonalUnlockHandlers } from './vault-unlock.js';
import { registerVaultManageHandlers } from './vault-manage.js';

export { rebuildMutationCallback, wireBackupServices } from './vault-wiring.js';
export { teardownBackupServices } from './vault-lock-flow.js';

/**
 * Lock the vault from the main process: sessions close, changes publish, the lease is released.
 * True when a personal vault was open (or opening) and is now locked.
 */
export async function lockVaultFromMain(cause: LockCause = 'other'): Promise<boolean> {
  return lockPersonalVault(AppState.getInstance(), cause);
}

/** The shared tail of every personal unlock: chat store, recent vaults, backups, biometric key. */
export async function finishPersonalUnlock(password: string, lineageId: string): Promise<void> {
  completePersonalUnlock(AppState.getInstance(), password, lineageId);
}

export function registerVaultHandlers(): void {
  const state = AppState.getInstance();
  installVaultAccessHandlers(state);

  // ── Vault lifecycle ──────────────────────────────────────────────

  registerPersonalUnlockHandlers(state);
  registerVaultManageHandlers(state);

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

  ipcMain.handle('vault_pick_file', async (_e, args: { mode: 'open' | 'save'; defaultDir?: unknown }) => {
    const win = AppState.getInstance().getMainWindow() ?? null;
    if (args.mode === 'save') {
      // "Make my own copy" opens next to the original so the copy syncs like it did.
      const dir = typeof args.defaultDir === 'string' && path.isAbsolute(args.defaultDir) ? args.defaultDir : null;
      const result = await dialog.showSaveDialog(win!, {
        title: 'Create New Vault',
        defaultPath: dir === null ? 'my-vault.conduit' : path.join(dir, 'my-vault.conduit'),
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
