/**
 * IPC handlers for chat cloud sync.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';

export function registerChatCloudSyncHandlers(): void {
  const state = AppState.getInstance();

  /** Get the current chat sync state. */
  ipcMain.handle('chat_cloud_sync_get_state', async () => {
    return state.chatCloudSync.getState();
  });

  /** Enable chat cloud sync, run full sync. */
  ipcMain.handle('chat_cloud_sync_enable', async () => {
    const authState = state.authService.getAuthState();
    if (!authState.isAuthenticated || !authState.user) {
      throw new Error('Not authenticated');
    }
    if (!state.chatStore.isUnlocked() || !state.currentMasterPassword) {
      throw new Error('Vault is locked');
    }

    // Store preference in vault_meta
    state.vault.setChatCloudSyncEnabled(true);

    // Configure sync service
    state.chatCloudSync.configure({
      chatStore: state.chatStore,
      masterPassword: state.currentMasterPassword,
      enabled: true,
    });

    // Engine conversations call state.chatCloudSync.notifyMutation directly
    // in electron/ipc/engine.ts when they mutate the chat store.

    // Run full sync in background
    await state.chatCloudSync.fullSync();
  });

  /** Disable chat cloud sync. */
  ipcMain.handle('chat_cloud_sync_disable', async () => {
    if (state.vault.isUnlocked()) {
      state.vault.setChatCloudSyncEnabled(false);
    }
    state.chatCloudSync.disable();
  });

  /** Force immediate sync. */
  ipcMain.handle('chat_cloud_sync_now', async () => {
    await state.chatCloudSync.syncNow();
  });

  /** Delete all cloud chat data. */
  ipcMain.handle('chat_cloud_sync_delete', async () => {
    await state.chatCloudSync.deleteCloudData();
    state.chatCloudSync.disable();
    if (state.vault.isUnlocked()) {
      state.vault.setChatCloudSyncEnabled(false);
    }
  });
}
