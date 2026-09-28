/**
 * Locking the personal vault (spec 6.4, 6.6). A manual lock (tray hide,
 * idle lock, switching vaults) closes every session, publishes and releases the lease. A soft
 * lock (another device took the vault over) clears the key and stops backups but leaves open
 * terminals, RDP, VNC, web sessions and running commands alone.
 */

import type { AppState } from '../services/state.js';
import type { LockedReason } from '../services/vault-session/host.js';

/** The AppState members the lock flows touch (tests pass fakes). */
export type LockFlowState = Pick<
  AppState,
  | 'vault'
  | 'chatStore'
  | 'cloudSync'
  | 'localBackup'
  | 'vaultWatcher'
  | 'appSync'
  | 'personalLockReason'
  | 'currentMasterPassword'
  | 'closeAllSessions'
>;

export type TeardownState = Pick<LockFlowState, 'vault' | 'cloudSync' | 'localBackup' | 'vaultWatcher' | 'currentMasterPassword'>;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** On vault lock, clear all backup service state. */
export function teardownBackupServices(state: TeardownState): void {
  state.currentMasterPassword = null;
  state.vaultWatcher?.stop();
  state.vaultWatcher = null;
  state.cloudSync.disable();
  state.localBackup.disable();
  state.vault.setOnMutation(null);
}

/**
 * Manual lock: sessions close, the last changes publish (3 s cap), the lease is released. An
 * unlock still in progress is cancelled and closed, and a displaced save finishes first, so
 * ConduitVault.lock() never closes the working copy under a running cycle.
 */
export async function lockPersonalVault(state: LockFlowState): Promise<void> {
  if (!state.vault.isUnlocked() && !state.appSync.hasSession()) return;
  try {
    await state.closeAllSessions();
  } catch (err) {
    // The vault still locks: a session that fails to close must not keep the key in memory.
    console.error('[vault] closing sessions before lock failed', { name: errName(err) });
  }
  teardownBackupServices(state);
  await state.appSync.lock();
  state.chatStore.lock();
  state.vault.lock();
  state.personalLockReason = null;
}

/** Displaced by another device: the key and backups go, open sessions keep running. */
export function softLockPersonalVault(state: LockFlowState, reason: LockedReason): void {
  teardownBackupServices(state);
  state.chatStore.lock();
  state.vault.lock();
  state.personalLockReason = reason;
  console.info('[vault-session] vault soft-locked; open sessions keep running', { reason });
}
