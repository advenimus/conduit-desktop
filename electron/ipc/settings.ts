/**
 * IPC handlers for application settings.
 *
 * Port of src-tauri/src/commands/settings.rs
 */

import { ipcMain, app, dialog } from 'electron';
import { AppState } from '../services/state.js';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir } from '../services/env-config.js';

// Session default types — mirrored from src/types/entry.ts to avoid cross-boundary imports
interface RdpGlobalDefaults {
  resolution: string;
  colorDepth: number;
  sound: string;
  quality: string;
  clipboard: boolean;
  enableNla: boolean;
  enableHighDpi: boolean;
  displayScale: number;
}

interface WebGlobalDefaults {
  autofillEnabled: boolean;
  ignoreCertErrors: boolean;
  engine: string;
}

interface TerminalGlobalDefaults {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
}

const HARDCODED_RDP_DEFAULTS: RdpGlobalDefaults = {
  resolution: "match_window", colorDepth: 32, sound: "local",
  quality: "good", clipboard: true, enableNla: true, enableHighDpi: false,
  displayScale: 1.0,
};

const HARDCODED_WEB_DEFAULTS: WebGlobalDefaults = {
  autofillEnabled: false, ignoreCertErrors: false, engine: "auto",
};

const HARDCODED_TERMINAL_DEFAULTS: TerminalGlobalDefaults = {
  fontSize: 14, scrollback: 10000, cursorBlink: true,
};

interface SshGlobalDefaults {
  authMethodWhenKeyPresent: string;
}

const HARDCODED_SSH_DEFAULTS: SshGlobalDefaults = {
  authMethodWhenKeyPresent: 'key',
};

export interface AppSettings {
  theme: string;
  color_scheme: string;
  platform_theme: string;
  default_shell: string;
  recent_vaults: string[];
  last_vault_path: string | null;
  ai_mode: 'api' | 'cli';
  cli_agent: 'claude' | 'codex';
  cli_font_size: number;
  sidebar_mode: 'pinned' | 'auto';
  // Unified engine settings
  default_engine: 'claude-code' | 'codex';
  default_working_directory: string | null;
  // Cached tier capabilities for offline/degraded mode
  cached_tier_capabilities?: Record<string, unknown>;
  cached_tier_timestamp?: string;
  cached_user_email?: string;
  // Terminal mode for CLI agents
  terminal_mode: boolean;
  // Local backup settings
  local_backup_enabled: boolean;
  local_backup_path: string | null;
  local_backup_retention_days: number;
  local_backup_include_chat: boolean;
  // Cached engine models for instant /model on cold start
  cached_engine_models?: Record<string, { models: import('../services/ai/engines/engine.js').EngineModelInfo[]; updatedAt: string }>;
  // Vault Hub: last-used vault context for auto-connect on launch
  last_vault_type: 'personal' | 'team' | null;
  last_team_vault_id: string | null;
  // Onboarding wizard shown to first-time users
  onboarding_completed: boolean;
  // UI zoom scale (1.0 = 100%)
  ui_scale: number;
  // Local mode: app version when user chose "Continue without signing in"
  local_mode_accepted_version: string | null;
  // Default web session engine (Windows-only: 'webview2' enables M365 SSO)
  default_web_engine: 'auto' | 'chromium' | 'webview2';
  // Session type global defaults
  session_defaults_rdp: RdpGlobalDefaults;
  session_defaults_web: WebGlobalDefaults;
  session_defaults_terminal: TerminalGlobalDefaults;
  session_defaults_ssh: SshGlobalDefaults;
  // MCP tool approval settings
  tool_approval_enabled: boolean;
  tool_approval_always_allow: string[];
  // What's New dialog — track last version user saw release notes for
  last_seen_whats_new_version: string | null;
  // Biometric unlock — vault keys where user dismissed the setup prompt
  biometric_dismissed_vaults: string[];
  // Opt out of anonymous analytics (event-based product telemetry)
  analytics_opt_out: boolean;
}

const defaultSettings: AppSettings = {
  theme: 'system',
  color_scheme: 'ocean',
  platform_theme: 'default',
  default_shell: 'default',
  recent_vaults: [],
  last_vault_path: null,
  ai_mode: 'api',
  cli_agent: 'claude',
  cli_font_size: 13,
  sidebar_mode: 'pinned',
  default_engine: 'claude-code',
  default_working_directory: null,
  terminal_mode: false,
  local_backup_enabled: false,
  local_backup_path: null,
  local_backup_retention_days: 30,
  local_backup_include_chat: true,
  last_vault_type: null,
  last_team_vault_id: null,
  onboarding_completed: false,
  ui_scale: 1.0,
  local_mode_accepted_version: null,
  default_web_engine: 'auto',
  session_defaults_rdp: { ...HARDCODED_RDP_DEFAULTS },
  session_defaults_web: { ...HARDCODED_WEB_DEFAULTS },
  session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS },
  session_defaults_ssh: { ...HARDCODED_SSH_DEFAULTS },
  tool_approval_enabled: true,
  tool_approval_always_allow: [],
  last_seen_whats_new_version: null,
  biometric_dismissed_vaults: [],
  analytics_opt_out: false,
};

export function settingsPath(): string {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'settings.json');
}

/** Read settings from disk (sync). Returns defaults if file doesn't exist. */
export function readSettings(): AppSettings {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) {
    return { ...defaultSettings };
  }
  try {
    const contents = fs.readFileSync(filePath, 'utf-8');
    const raw = JSON.parse(contents);
    const parsed = { ...defaultSettings, ...raw };
    // Migrate existing users: if file existed but had no onboarding_completed,
    // mark as completed so existing users don't see the wizard
    if (raw.onboarding_completed === undefined) {
      parsed.onboarding_completed = true;
    }
    // Remove stale default_ai_model from old settings files
    if ('default_ai_model' in parsed) {
      delete (parsed as Record<string, unknown>).default_ai_model;
    }
    // Migrate: populate session_defaults_web.engine from legacy default_web_engine
    if (!raw.session_defaults_web && raw.default_web_engine) {
      parsed.session_defaults_web = {
        ...HARDCODED_WEB_DEFAULTS,
        engine: raw.default_web_engine,
      };
    }
    return parsed;
  } catch {
    return { ...defaultSettings };
  }
}

/** Write settings to disk (sync). */
export function writeSettings(settings: AppSettings): void {
  const filePath = settingsPath();
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

/** Update recent_vaults and last_vault_path after opening/creating a vault. */
export function updateRecentVaults(vaultPath: string): void {
  const settings = readSettings();
  settings.last_vault_path = vaultPath;

  // Deduplicate and prepend the new path, cap at 10
  const filtered = settings.recent_vaults.filter((p) => p !== vaultPath);
  settings.recent_vaults = [vaultPath, ...filtered].slice(0, 10);

  writeSettings(settings);
}

/** Update the last-used vault context for Vault Hub auto-connect. */
export function updateLastVaultContext(type: 'personal' | 'team', teamVaultId?: string): void {
  const settings = readSettings();
  settings.last_vault_type = type;
  settings.last_team_vault_id = teamVaultId ?? null;
  writeSettings(settings);
}

export function registerSettingsHandlers(): void {
  // ── app_get_version ─────────────────────────────────────────────────
  ipcMain.handle('app_get_version', () => app.getVersion());

  // ── settings_get ───────────────────────────────────────────────────
  ipcMain.handle('settings_get', async () => {
    return readSettings();
  });

  // ── settings_save ──────────────────────────────────────────────────
  ipcMain.handle('settings_save', async (_e, args: { settings: AppSettings }) => {
    writeSettings(args.settings);
  });

  // ── settings_remove_recent_vault ──────────────────────────────────
  ipcMain.handle('settings_remove_recent_vault', async (_e, args: { vaultPath: string }) => {
    const settings = readSettings();
    settings.recent_vaults = settings.recent_vaults.filter((p) => p !== args.vaultPath);
    if (settings.last_vault_path === args.vaultPath) {
      settings.last_vault_path = settings.recent_vaults[0] ?? null;
    }
    writeSettings(settings);

    // Clean up biometric data for the removed vault
    try {
      const { getBiometricService, vaultPathToKey } = await import('../services/vault/biometric.js');
      getBiometricService().removePassword(vaultPathToKey(args.vaultPath));
    } catch {
      // Best-effort cleanup
    }

    return settings.recent_vaults;
  });

  // ── settings_clear_recent_vaults ────────────────────────────────────
  ipcMain.handle('settings_clear_recent_vaults', async () => {
    const settings = readSettings();
    settings.recent_vaults = [];
    settings.last_vault_path = null;
    writeSettings(settings);

    // Clean up all biometric data
    try {
      const { getBiometricService } = await import('../services/vault/biometric.js');
      getBiometricService().removeAll();
    } catch {
      // Best-effort cleanup
    }

    return settings.recent_vaults;
  });

  // ── app_relaunch ──────────────────────────────────────────────────
  ipcMain.handle('app_relaunch', () => {
    app.relaunch();
    app.quit();
  });

  // ── dialog_select_folder ────────────────────────────────────────────
  ipcMain.handle('dialog_select_folder', async (_e, args?: { title?: string }) => {
    const win = AppState.getInstance().getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: args?.title ?? 'Select Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
