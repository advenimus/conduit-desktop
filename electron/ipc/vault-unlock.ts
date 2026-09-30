/**
 * The personal-vault unlock channels (spec 6.3; vault_open and the unlock variants). Every one
 * goes through AppSyncManager.openPersonalVault (early in-use check, password, lease, working
 * copy and engine for shared vaults) and then the common tail in vault-wiring.ts. A failed
 * open leaves nothing open; its error reaches the renderer unchanged (plain text, or the
 * structured JSON the unlock dialogs parse).
 */

import { ipcMain } from 'electron';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import type { PersonalOpenOutcome, PersonalOpenRequest } from '../services/sync/app-sync-manager.js';
import { migrateToConduit } from '../services/vault/migration.js';
import { PersonalVaultOpenError } from '../services/vault-session/open-personal-vault.js';
import { completePersonalUnlock } from './vault-wiring.js';
import { lockPersonalVault } from './vault-lock-flow.js';
import { updateRecentVaults } from './settings.js';

const MASTER_PASSWORD_REQUIRED_MESSAGE = 'Master password is required';
const VAULT_PATH_REQUIRED_MESSAGE = 'Choose a vault file first';

export interface UnlockArgs {
  readonly masterPassword: string;
  readonly previousPassword: string | null;
  readonly takeover: boolean;
  readonly recoverWorkingCopy: boolean;
}

function record(args: unknown): Readonly<Record<string, unknown>> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/**
 * Electron sends a rejected handler's error as `${name}: ${message}`, and the renderer strips
 * only a plain "Error: " before parsing the structured JSON, so the custom name must not cross.
 */
function forRenderer(err: unknown): unknown {
  return err instanceof PersonalVaultOpenError ? new Error(err.message) : err;
}

export function requireMasterPassword(args: unknown, field = 'masterPassword'): string {
  const v = record(args)[field];
  if (typeof v !== 'string') throw new Error(MASTER_PASSWORD_REQUIRED_MESSAGE);
  return v;
}

export function requireVaultPathArg(args: unknown, field = 'filePath'): string {
  const v = record(args)[field];
  if (typeof v !== 'string' || v.trim() === '' || v.includes('\0')) throw new Error(VAULT_PATH_REQUIRED_MESSAGE);
  return path.resolve(v);
}

function optionalText(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** vault_unlock / biometric_unlock options: previousPassword, takeover, recoverWorkingCopy. */
export function parseUnlockOptions(args: unknown): Omit<UnlockArgs, 'masterPassword'> {
  const a = record(args);
  return {
    previousPassword: optionalText(a.previousPassword),
    takeover: a.takeover === true,
    recoverWorkingCopy: a.recoverWorkingCopy === true,
  };
}

export function parseUnlockArgs(args: unknown): UnlockArgs {
  return { masterPassword: requireMasterPassword(args), ...parseUnlockOptions(args) };
}

/** Sees the typed open error before it is flattened for the renderer. */
export type OpenRefusedHook = (err: unknown) => Promise<void>;

async function runRefusedHook(onRefused: OpenRefusedHook, err: unknown, source: string): Promise<void> {
  try {
    await onRefused(err);
  } catch (hookErr) {
    console.error('[vault] handling a refused unlock failed', { source, name: errName(hookErr) });
  }
}

/** openPersonalVault, then the common tail. The tail never fails an unlock that succeeded. */
export async function openPersonalAndFinish(
  state: AppState,
  req: PersonalOpenRequest,
  onRefused?: OpenRefusedHook,
): Promise<PersonalOpenOutcome> {
  let outcome: PersonalOpenOutcome;
  try {
    outcome = await state.appSync.openPersonalVault(req);
  } catch (err) {
    console.warn('[vault] personal unlock refused', { source: req.source, name: errName(err) });
    if (onRefused !== undefined) await runRefusedHook(onRefused, err, req.source);
    throw forRenderer(err);
  }
  try {
    completePersonalUnlock(state, req.password, outcome.lineageId, req.previousPassword ?? null);
  } catch (err) {
    console.error('[vault] post-unlock setup failed', { source: req.source, name: errName(err) });
  }
  console.info('[vault] personal vault unlocked', { source: req.source, shared: outcome.shared, engine: outcome.engine });
  return outcome;
}

export function registerPersonalUnlockHandlers(state: AppState): void {
  ipcMain.handle('vault_initialize', async (_e, args) => {
    const password = requireMasterPassword(args);
    await openPersonalAndFinish(state, { path: state.currentVaultPath, password, create: true, source: 'vault_initialize' });
  });

  ipcMain.handle('vault_unlock', async (_e, args) => {
    const a = parseUnlockArgs(args);
    await openPersonalAndFinish(state, {
      path: state.currentVaultPath,
      password: a.masterPassword,
      previousPassword: a.previousPassword,
      takeover: a.takeover,
      recoverWorkingCopy: a.recoverWorkingCopy,
      source: 'vault_unlock',
    });
  });

  ipcMain.handle('vault_create', async (_e, args) => {
    const filePath = requireVaultPathArg(args);
    const password = requireMasterPassword(args);
    await lockPersonalVault(state);
    state.switchVault(filePath);
    await openPersonalAndFinish(state, { path: filePath, password, create: true, source: 'vault_create' });
    return filePath;
  });

  ipcMain.handle('vault_open', async (_e, args) => {
    const filePath = requireVaultPathArg(args);
    await lockPersonalVault(state);
    state.switchVault(filePath);
    updateRecentVaults(filePath);
    return { filePath, exists: state.vault.exists() };
  });

  ipcMain.handle('migrate_legacy_vault', async (_e, args) => {
    const password = requireMasterPassword(args);
    const dataDir = state.getDataDir();
    const newVaultPath = state.getDefaultVaultPath();
    const result = migrateToConduit(
      state.getLegacyConnectionsPath(),
      path.join(dataDir, 'vault.db'),
      path.join(dataDir, 'vault.salt'),
      newVaultPath,
      password,
    );
    await lockPersonalVault(state);
    state.switchVault(newVaultPath);
    await openPersonalAndFinish(state, { path: newVaultPath, password, source: 'migrate_legacy_vault' });
    return result;
  });
}
