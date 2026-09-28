/**
 * AI IPC handlers for the Electron main process.
 *
 * Registers handlers for tier capabilities and MCP binary path lookup.
 * Chat now flows through external CLI engines (Claude Code, Codex) via
 * electron/ipc/engine.ts; the CLIs manage their own session history.
 */

import { ipcMain, app } from 'electron';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import { usableCachedTier } from '../services/auth/tier-cache.js';
import { readSettings, writeSettings } from './settings.js';
import { buildTierCapabilities, NO_PROFILE_CAPABILITIES, type TierCapabilities } from './tier-capabilities.js';

function cacheTierCapabilities(capabilities: TierCapabilities, email: string | undefined): void {
  try {
    const settings = readSettings();
    settings.cached_tier_capabilities = { ...capabilities };
    settings.cached_tier_timestamp = new Date().toISOString();
    settings.cached_user_email = email;
    writeSettings(settings);
  } catch (err) {
    console.warn('[ai:ipc] Failed to cache tier capabilities:', err);
  }
}

export function registerAiHandlers(state: AppState): void {
  ipcMain.handle('ai_get_mcp_path', async () => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp', 'dist', 'index.js');
    }
    return path.resolve(app.getAppPath(), 'mcp', 'dist', 'index.js');
  });

  // ── Tier-aware handlers ──────────────────────────────────────────────────

  /** Returns the user's feature flags for frontend gating and caches them for offline use. */
  ipcMain.handle('ai_get_tier_capabilities', async () => {
    const authState = state.authService.getAuthState();
    let profile = authState.profile;

    // If authenticated but profile hasn't loaded yet (race condition on startup),
    // fetch it directly before computing capabilities.
    if (!profile && authState.user) {
      try {
        profile = await state.authService.getUserProfile();
      } catch { /* fall through to defaults */ }
    }

    if (!profile) return NO_PROFILE_CAPABILITIES;

    const capabilities = buildTierCapabilities(profile);
    cacheTierCapabilities(capabilities, authState.user?.email);
    return capabilities;
  });

  /** Returns cached tier capabilities from settings (for offline mode). */
  ipcMain.handle('ai_get_cached_tier_capabilities', async () => {
    try {
      return usableCachedTier(readSettings(), Date.now());
    } catch {
      return null;
    }
  });
}
