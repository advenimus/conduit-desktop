/**
 * IPC handlers for Supabase authentication.
 */

import { ipcMain, shell, app, net } from 'electron';
import dns from 'node:dns/promises';
import { AppState } from '../services/state.js';
import { getEnvConfig } from '../services/env-config.js';
import { readSettings, writeSettings } from './settings.js';

export function registerAuthHandlers(): void {
  const state = AppState.getInstance();

  // Network reachability monitor.
  // Electron's net.isOnline() and renderer's navigator.onLine only check OS
  // network interfaces — they return true when WiFi is off (loopback is up).
  // A dns.lookup uses getaddrinfo (the same syscall that fails with ENOTFOUND
  // in the Supabase errors) so it reliably detects actual internet loss.
  // We probe both Supabase and the website — only report offline if BOTH fail,
  // so a single service outage doesn't falsely trigger offline mode.
  const envConfig = getEnvConfig();
  const probeHosts = [
    new URL(envConfig.supabaseUrl).hostname,
    new URL(envConfig.websiteUrl).hostname,
  ];
  let lastOnline: boolean | null = null;

  async function probeConnectivity(): Promise<boolean> {
    const results = await Promise.all(
      probeHosts.map((host) => dns.lookup(host).then(() => true, () => false))
    );
    return results.some((r) => r); // online if ANY host resolves
  }

  setInterval(async () => {
    const online = await probeConnectivity();
    if (online !== lastOnline) {
      lastOnline = online;
      console.log(`[auth] Network status changed: ${online ? 'online' : 'offline'}`);
      const win = state.getMainWindow();
      if (win) win.webContents.send('network:status-changed', online);
    }
  }, 5_000);

  ipcMain.handle('auth_initialize', async () => {
    const authState = await state.authService.initialize();
    // If unauthenticated, check whether user previously accepted local mode for this version
    if (!authState.isAuthenticated && !authState.authMode) {
      const settings = readSettings();
      if (settings.local_mode_accepted_version === app.getVersion()) {
        return { ...authState, authMode: 'local' };
      }
      // Auto-enter local mode when offline with no usable session
      if (!net.isOnline()) {
        console.log('[auth] Offline with no session, auto-entering local mode');
        return { ...authState, authMode: 'local' };
      }
    }
    return authState;
  });

  ipcMain.handle('auth_open_login', () => {
    const config = getEnvConfig();
    shell.openExternal(`${config.websiteUrl}/login?desktop=true`);
  });

  ipcMain.handle('auth_open_signup', () => {
    const config = getEnvConfig();
    shell.openExternal(`${config.websiteUrl}/signup?desktop=true`);
  });

  ipcMain.handle('auth_open_account', () => {
    const config = getEnvConfig();
    shell.openExternal(`${config.websiteUrl}/account`);
  });

  ipcMain.handle('auth_open_pricing', () => {
    const config = getEnvConfig();
    shell.openExternal(`${config.websiteUrl}/pricing`);
  });

  ipcMain.handle('auth_open_download', () => {
    const config = getEnvConfig();
    shell.openExternal(`${config.websiteUrl}/download`);
  });

  ipcMain.handle('auth_open_website', () => {
    const config = getEnvConfig();
    shell.openExternal(config.websiteUrl);
  });

  ipcMain.handle('auth_open_mobile_download', () => {
    shell.openExternal('https://apps.apple.com/app/id6760924705');
  });

  ipcMain.handle('auth_sign_out', async () => {
    await state.authService.signOut();
    const settings = readSettings();
    settings.local_mode_accepted_version = null;
    writeSettings(settings);
  });

  ipcMain.handle('auth_set_local_mode', () => {
    const settings = readSettings();
    settings.local_mode_accepted_version = app.getVersion();
    writeSettings(settings);
  });

  ipcMain.handle('auth_get_state', async () => {
    return state.authService.getAuthState();
  });

  ipcMain.handle('auth_get_profile', async () => {
    return state.authService.getUserProfile();
  });

  ipcMain.handle('auth_refresh', async () => {
    return state.authService.refreshSession();
  });

  ipcMain.handle('auth_resend_confirmation', async (_e, args) => {
    const { email } = args as { email: string };
    return state.authService.resendConfirmation(email);
  });

  ipcMain.handle('auth_get_usage', async () => {
    return state.authService.getUsage();
  });

  // MFA status check (read-only — enrollment and verification happen on the website)
  ipcMain.handle('auth_mfa_status', async () => {
    return state.authService.getMfaStatus();
  });
}
