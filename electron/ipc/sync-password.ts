/**
 * After a sync flow changed the vault password (spec 4.8: the new password entered after a
 * change on another device, a legacy change adopted, concurrent changes resolved), the rest of
 * the app follows: the password held for backups, the chat store key, the backup services, the
 * stored biometric password and the saved automatic unlock. Each step is best effort and logged; the vault itself already
 * opens with the new password.
 */

import type { AppState } from '../services/state.js';
import { resolveBiometricKeys, restoreBiometricAfterPasswordChange } from './biometric-lineage.js';
import { wireBackupServices } from './vault.js';
import { resealAfterPasswordChange, savedUnlockForCurrent } from './auto-unlock-lifecycle.js';
import { lifecycleDeps } from './startup-vault.js';

const LOG = '[sync]';

function errName(err: unknown): string {
  return (err as Error)?.name ?? 'Error';
}

function rekeyChatStore(state: AppState, previous: string | null, next: string): void {
  const chat = state.chatStore;
  try {
    if (chat.isUnlocked() && previous !== null) chat.changePassword(previous, next);
    else if (!chat.isUnlocked() && chat.exists()) chat.unlock(next);
  } catch (err) {
    console.warn(`${LOG} chat store did not take the new vault password`, { name: errName(err) });
  }
}

function rewireBackups(state: AppState, next: string): void {
  try {
    wireBackupServices(state, next);
  } catch (err) {
    console.error(`${LOG} backups could not restart with the new vault password`, { name: errName(err) });
  }
}

export async function applyVaultPasswordChange(state: AppState, next: string): Promise<void> {
  const previous = state.currentMasterPassword;
  if (previous === next) return;
  // A synced vault keeps its lineage across a password change, so these are the keys in use now.
  const biometricKeys = await resolveBiometricKeys(state, state.currentVaultPath);
  const autoUnlock = lifecycleDeps(state);
  const autoUnlockBefore = savedUnlockForCurrent(autoUnlock);
  rekeyChatStore(state, previous, next);
  state.currentMasterPassword = next;
  rewireBackups(state, next);
  await restoreBiometricAfterPasswordChange(state, biometricKeys, next);
  await resealAfterPasswordChange(autoUnlock, autoUnlockBefore, next);
  console.info(`${LOG} app follow-up after a vault password change done`);
}
