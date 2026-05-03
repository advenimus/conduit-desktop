/**
 * AI IPC handlers for the Electron main process.
 *
 * Registers handlers for tier capabilities and MCP binary path lookup.
 * Chat now flows through external CLI engines (Claude Code, Codex) via
 * electron/ipc/engine.ts; the CLIs manage their own session history.
 */

import { ipcMain, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import { readSettings, writeSettings } from './settings.js';
import { getDataDir } from '../services/env-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface QuotaUsage {
  quota: number;
  count: number;
  remaining: number;
  resetAt: number | null;
}

/**
 * Resolve the active tier's MCP daily quota.
 * Returns -1 when the tier is unlimited or auth state is missing (defensive
 * default mirrors `ai_get_tier_capabilities` fallback below).
 */
async function resolveMcpQuota(state: AppState): Promise<number> {
  const authState = state.authService.getAuthState();
  let profile = authState.profile;
  if (!profile && authState.user) {
    try {
      profile = await state.authService.getUserProfile();
    } catch { /* fall through to defaults */ }
  }
  if (!profile) return 50;
  const features = (profile.tier?.features as Record<string, unknown> | undefined) ?? {};
  return typeof features.mcp_daily_quota === 'number' ? features.mcp_daily_quota : 50;
}

/**
 * Read the MCP-side quota ledger and compute current usage.
 * Mirrors the prune logic in `mcp/src/daily-quota.ts` so the desktop sees the
 * same rolling-window count the MCP enforces. Missing/corrupt file → zero.
 */
function readQuotaUsage(quota: number): QuotaUsage {
  if (quota === -1) {
    return { quota: -1, count: 0, remaining: -1, resetAt: null };
  }
  const filePath = path.join(getDataDir(), 'mcp-quota.json');
  let calls: number[] = [];
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { calls?: unknown };
      if (Array.isArray(parsed.calls)) {
        calls = parsed.calls.filter((n): n is number => typeof n === 'number');
      }
    }
  } catch {
    // Corrupt or unreadable — same posture as MCP: start fresh.
    calls = [];
  }
  const cutoff = Date.now() - DAY_MS;
  const fresh = calls.filter((ts) => ts > cutoff).sort((a, b) => a - b);
  const count = fresh.length;
  return {
    quota,
    count,
    remaining: Math.max(0, quota - count),
    resetAt: count > 0 ? fresh[0] + DAY_MS : null,
  };
}

export function registerAiHandlers(state: AppState): void {
  ipcMain.handle('ai_get_mcp_path', async () => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp', 'dist', 'index.js');
    }
    return path.resolve(app.getAppPath(), 'mcp', 'dist', 'index.js');
  });

  // ── Tier-aware handlers ──────────────────────────────────────────────────

  /** Returns the user's AI feature flags for frontend gating. */
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

    if (!profile) {
      return {
        cli_agents_enabled: false,
        mcp_enabled: false,
        mcp_daily_quota: 50,
        cloud_sync_enabled: false,
        shared_vaults: false,
        tier_name: 'free',
        tier_display_name: 'Free',
        is_team_member: false,
      };
    }

    const features = profile.tier?.features as Record<string, unknown> ?? {};

    const capabilities = {
      cli_agents_enabled: !!features.cli_agents_enabled,
      mcp_enabled: !!features.mcp_enabled,
      mcp_daily_quota: typeof features.mcp_daily_quota === 'number' ? features.mcp_daily_quota : 50,
      cloud_sync_enabled: !!features.cloud_sync_enabled,
      shared_vaults: !!features.shared_vaults,
      tier_name: profile.tier?.name ?? 'free',
      tier_display_name: profile.tier?.display_name ?? 'Free',
      is_team_member: profile.is_team_member,
    };

    // Cache tier capabilities for offline/degraded mode
    try {
      const settings = readSettings();
      settings.cached_tier_capabilities = capabilities;
      settings.cached_tier_timestamp = new Date().toISOString();
      settings.cached_user_email = authState.user?.email;
      writeSettings(settings);
    } catch (err) {
      console.warn('[ai:ipc] Failed to cache tier capabilities:', err);
    }

    return capabilities;
  });

  /** Returns the user's current MCP daily-quota usage (live count from disk). */
  ipcMain.handle('mcp_get_quota_usage', async (): Promise<QuotaUsage> => {
    const quota = await resolveMcpQuota(state);
    return readQuotaUsage(quota);
  });

  /** Returns cached tier capabilities from settings (for offline mode). */
  ipcMain.handle('ai_get_cached_tier_capabilities', async () => {
    try {
      const settings = readSettings();
      if (!settings.cached_tier_capabilities || !settings.cached_tier_timestamp) return null;
      const age = Date.now() - new Date(settings.cached_tier_timestamp).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (age > sevenDays) return null;
      return settings.cached_tier_capabilities;
    } catch {
      return null;
    }
  });
}
