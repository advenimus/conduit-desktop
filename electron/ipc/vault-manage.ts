/**
 * vault_rename and vault_change_password.
 * A vault the sync engine manages renames only its shared file and changes its password in
 * one working-copy transaction with a new key epoch (spec 4.8); a vault opened in place keeps
 * today's lock, rename and re-unlock, and today's in-place password change.
 */

import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import { readSettings, writeSettings } from './settings.js';
import { resolveBiometricKeys, restoreBiometricAfterPasswordChange } from './biometric-lineage.js';
import { teardownBackupServices } from './vault-lock-flow.js';
import { wireBackupServices } from './vault-wiring.js';
import { openPersonalAndFinish, requireMasterPassword } from './vault-unlock.js';

const VAULT_EXTENSION = '.conduit';
const SIDE_FILE_SUFFIXES = ['-wal', '-shm'] as const;

function record(args: unknown): Readonly<Record<string, unknown>> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** Strip the .conduit suffix and path separators, and trim. */
export function sanitizeVaultName(newName: unknown): string {
  const raw = typeof newName === 'string' ? newName : '';
  const sanitized = raw.replace(/\.conduit$/i, '').replace(/[/\\]/g, '').trim();
  if (!sanitized) throw new Error('Invalid vault name');
  return sanitized;
}

function requirePersonalUnlocked(state: AppState, what: 'rename' | 'change password'): void {
  if (!state.vault.isUnlocked()) throw new Error(`Vault must be unlocked to ${what}`);
  if (state.teamVaultManager.getActiveVault()) {
    throw new Error(what === 'rename' ? 'Cannot rename a team vault from here' : 'Cannot change password on a team vault');
  }
}

function recordRenameInSettings(oldPath: string, newPath: string): void {
  const settings = readSettings();
  settings.last_vault_path = newPath;
  settings.recent_vaults = settings.recent_vaults.map((p) => (p === oldPath ? newPath : p));
  writeSettings(settings);
}

async function renameShared(state: AppState, oldPath: string, fileName: string, masterPassword: string): Promise<string> {
  const newPath = await state.appSync.renameShared(fileName);
  state.vault.rebindSharedPath(newPath);
  state.currentVaultPath = newPath;
  recordRenameInSettings(oldPath, newPath);
  wireBackupServices(state, masterPassword);
  console.info('[vault] renamed the shared vault file');
  return newPath;
}

async function renameInPlace(state: AppState, oldPath: string, newPath: string, masterPassword: string): Promise<string> {
  teardownBackupServices(state);
  await state.appSync.lock();
  state.vault.lock();
  fs.renameSync(oldPath, newPath);
  for (const suffix of SIDE_FILE_SUFFIXES) {
    const old = oldPath + suffix;
    if (fs.existsSync(old)) fs.renameSync(old, newPath + suffix);
  }
  state.switchVault(newPath);
  recordRenameInSettings(oldPath, newPath);
  await openPersonalAndFinish(state, { path: newPath, password: masterPassword, source: 'vault_rename' });
  return newPath;
}

async function renameVault(state: AppState, args: unknown): Promise<string> {
  requirePersonalUnlocked(state, 'rename');
  // Read before any teardown clears it.
  const masterPassword = state.currentMasterPassword;
  if (!masterPassword) throw new Error('Master password not available');
  const sanitized = sanitizeVaultName(record(args).newName);
  const oldPath = state.currentVaultPath;
  const newPath = path.join(path.dirname(oldPath), `${sanitized}${VAULT_EXTENSION}`);
  if (newPath === oldPath) return oldPath;
  if (fs.existsSync(newPath)) {
    throw new Error(`A vault named "${sanitized}${VAULT_EXTENSION}" already exists in this directory`);
  }
  return state.appSync.isEngineManaged()
    ? renameShared(state, oldPath, `${sanitized}${VAULT_EXTENSION}`, masterPassword)
    : renameInPlace(state, oldPath, newPath, masterPassword);
}

interface ChangePasswordArgs {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly eraseRecentlyDeleted: boolean;
}

function parseChangePassword(args: unknown): ChangePasswordArgs {
  return {
    currentPassword: requireMasterPassword(args, 'currentPassword'),
    newPassword: requireMasterPassword(args, 'newPassword'),
    eraseRecentlyDeleted: record(args).eraseRecentlyDeleted === true,
  };
}

function revertChatStore(state: AppState, a: ChangePasswordArgs): void {
  try {
    state.chatStore.changePassword(a.newPassword, a.currentPassword);
  } catch (err) {
    console.warn('[vault] chat store kept the new password after a failed vault password change', { name: errName(err) });
  }
}

async function changeVaultPassword(state: AppState, a: ChangePasswordArgs, engine: boolean): Promise<void> {
  if (engine) {
    await state.appSync.changePassword(a.currentPassword, a.newPassword, a.eraseRecentlyDeleted);
    return;
  }
  state.vault.changePassword(a.currentPassword, a.newPassword);
  // Salt and key_source are written outside the rekey transaction; flush them into the file.
  state.vault.save();
}

async function changePassword(state: AppState, args: unknown): Promise<void> {
  requirePersonalUnlocked(state, 'change password');
  const a = parseChangePassword(args);
  const engine = state.appSync.isEngineManaged();
  const previousPassword = state.currentMasterPassword;
  const biometricBefore = await resolveBiometricKeys(state, state.currentVaultPath);

  // Stop in-flight backups before re-encryption.
  teardownBackupServices(state);
  // Re-key chat store BEFORE vault: if this fails, nothing has changed yet.
  const chatRekeyed = state.chatStore.exists() && state.chatStore.isUnlocked();
  try {
    if (chatRekeyed) state.chatStore.changePassword(a.currentPassword, a.newPassword);
  } catch (err) {
    if (previousPassword) wireBackupServices(state, previousPassword);
    throw err;
  }
  try {
    await changeVaultPassword(state, a, engine);
  } catch (err) {
    if (chatRekeyed) revertChatStore(state, a);
    if (previousPassword) wireBackupServices(state, previousPassword);
    throw err;
  }
  wireBackupServices(state, a.newPassword);
  await restoreBiometricAfterPasswordChange(state, biometricBefore, a.newPassword);
  console.info('[vault] vault password changed', { engine });
}

export function registerVaultManageHandlers(state: AppState): void {
  ipcMain.handle('vault_rename', async (_e, args) => renameVault(state, args));
  ipcMain.handle('vault_change_password', async (_e, args) => changePassword(state, args));
}
