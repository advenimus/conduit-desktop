/**
 * IPC handlers for application settings.
 *
 * Port of src-tauri/src/commands/settings.rs
 */

import { ipcMain, app, dialog, shell, nativeTheme } from 'electron';
import { AppState } from '../services/state.js';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir } from '../services/env-config.js';
import { getLocalNetworkStatus } from '../services/local-network.js';
import type { EngineType } from '../services/ai/engines/engine.js';
import { isKnownEngineType } from '../services/ai/cli-harnesses.js';
import { clearRecentVaults, removeRecentVault, type RecentVaultDeps } from './recent-vaults.js';
import { applyAppearanceMigration, migrateAppearance, type AppearanceSettings } from '../services/appearance-migration.js';
import { windowBackground } from '../services/appearance-palette.js';

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
  // Appearance (docs/VISUAL_REDESIGN.md 6.1); the migration in readSettings() fills them for older files
  icon_pack: string;
  appearance_version: number;
  default_shell: string;
  recent_vaults: string[];
  last_vault_path: string | null;
  ai_mode: 'api' | 'cli';
  cli_agent: 'claude' | 'codex';
  cli_font_size: number;
  // Unified engine settings
  default_engine: EngineType;
  default_working_directory: string | null;
  // Cached tier capabilities for offline/degraded mode
  cached_tier_capabilities?: Record<string, unknown>;
  cached_tier_timestamp?: string;
  cached_user_email?: string;
  // Local backup settings
  local_backup_enabled: boolean;
  local_backup_path: string | null;
  local_backup_retention_days: number;
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
  // What's New dialog — track last version user saw release notes for
  last_seen_whats_new_version: string | null;
  // Biometric unlock — vault keys where user dismissed the setup prompt
  biometric_dismissed_vaults: string[];
  // Opt out of anonymous analytics (event-based product telemetry)
  analytics_opt_out: boolean;
  // Has the user explicitly picked an AI engine via the first-launch picker?
  // False = picker shows on next agent panel open. True = use default_engine silently.
  engine_picker_completed: boolean;
  // Personal-vault multi-device sync; no UI, kept for support (docs/MULTI_DEVICE_SYNC.md 5.11)
  personal_sync_enabled: boolean;
  // Idle auto-lock of the personal vault in minutes; 0 = off
  vault_idle_lock_minutes: number;
}

const defaultSettings: AppSettings = {
  theme: 'system',
  color_scheme: 'modern',
  icon_pack: 'lucide',
  appearance_version: 2,
  default_shell: 'default',
  recent_vaults: [],
  last_vault_path: null,
  ai_mode: 'api',
  cli_agent: 'claude',
  cli_font_size: 13,
  default_engine: 'claude-code',
  default_working_directory: null,
  local_backup_enabled: false,
  local_backup_path: null,
  local_backup_retention_days: 30,
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
  last_seen_whats_new_version: null,
  biometric_dismissed_vaults: [],
  analytics_opt_out: false,
  engine_picker_completed: false,
  personal_sync_enabled: true,
  vault_idle_lock_minutes: 0,
};

export function settingsPath(): string {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'settings.json');
}

let appearanceWriteBackFailed = false;

/** Writes the migrated appearance keys into the file once, leaving every other stored key as it was. */
function persistAppearanceMigration(filePath: string, raw: Record<string, unknown>, values: AppearanceSettings): void {
  if (appearanceWriteBackFailed) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(applyAppearanceMigration(raw, values), null, 2), 'utf-8');
  } catch (err) {
    appearanceWriteBackFailed = true;
    console.warn('[settings] Could not save the migrated appearance settings; the migration will run again on each read:', err);
  }
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
    const rawRecord: Record<string, unknown> | null = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null;
    // The version check must read the raw file: the defaults already hold appearance_version 2.
    const appearance = migrateAppearance(rawRecord);
    const parsed = applyAppearanceMigration({ ...defaultSettings, ...raw }, appearance.values) as AppSettings;
    if (appearance.changed && rawRecord) {
      persistAppearanceMigration(filePath, rawRecord, appearance.values);
    }
    // Migrate existing users: if file existed but had no onboarding_completed,
    // mark as completed so existing users don't see the wizard
    if (raw.onboarding_completed === undefined) {
      parsed.onboarding_completed = true;
    }
    // Remove stale default_ai_model from old settings files
    if ('default_ai_model' in parsed) {
      delete (parsed as Record<string, unknown>).default_ai_model;
    }
    // Remove stale local_backup_include_chat (chat history was removed)
    if ('local_backup_include_chat' in parsed) {
      delete (parsed as Record<string, unknown>).local_backup_include_chat;
    }
    // Remove stale terminal_mode (CLI agents are now always native terminals)
    if ('terminal_mode' in parsed) {
      delete (parsed as Record<string, unknown>).terminal_mode;
    }
    // Remove stale sidebar_mode (never wired up; the sidebar pin lives in renderer storage)
    if ('sidebar_mode' in parsed) {
      delete (parsed as Record<string, unknown>).sidebar_mode;
    }
    if (!isKnownEngineType(String(parsed.default_engine))) {
      parsed.default_engine = 'claude-code';
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

async function recentVaultDeps(): Promise<RecentVaultDeps<AppSettings>> {
  const [{ removeBiometricForPath }, { getBiometricService }] = await Promise.all([
    import('./biometric-lineage.js'),
    import('../services/vault/biometric.js'),
  ]);
  return {
    read: readSettings,
    write: writeSettings,
    removeBiometric: (vaultPath) => removeBiometricForPath(AppState.getInstance(), vaultPath),
    removeAllBiometric: () => getBiometricService().removeAll(),
  };
}

/** Update the last-used vault context for Vault Hub auto-connect. */
export function updateLastVaultContext(type: 'personal' | 'team', teamVaultId?: string): void {
  const settings = readSettings();
  settings.last_vault_type = type;
  settings.last_team_vault_id = teamVaultId ?? null;
  writeSettings(settings);
}

/** The native window background follows the saved scheme and mode (docs/VISUAL_REDESIGN.md 7.2). */
function refreshWindowBackground(settings: AppSettings): void {
  try {
    const win = AppState.getInstance().getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.setBackgroundColor(windowBackground(settings, nativeTheme.shouldUseDarkColors));
  } catch (err) {
    console.warn('[settings] Could not update the window background color:', err);
  }
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
    refreshWindowBackground(args.settings);
  });

  // ── settings_remove_recent_vault / settings_clear_recent_vaults ────
  ipcMain.handle('settings_remove_recent_vault', async (_e, args: { vaultPath: string }) => {
    if (typeof args?.vaultPath !== 'string') throw new Error('Invalid vault path');
    return removeRecentVault(await recentVaultDeps(), args.vaultPath);
  });

  ipcMain.handle('settings_clear_recent_vaults', async () => {
    return clearRecentVaults(await recentVaultDeps());
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

  // ── local_network_status ────────────────────────────────────────────
  // Briefly cached rather than fixed at launch: the user may grant access in
  // System Settings and come straight back, and macOS applies that at once.
  ipcMain.handle('local_network_status', () => getLocalNetworkStatus());

  // ── open_local_network_settings ─────────────────────────────────────
  // macOS 27 has no URL anchor for the Local Network sub-pane, so this lands
  // on Privacy & Security and the user picks Local Network from the list.
  ipcMain.handle('open_local_network_settings', async () => {
    if (process.platform !== 'darwin') return false;
    try {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
      );
      return true;
    } catch (err) {
      console.error('[settings] Failed to open Local Network settings:', err);
      return false;
    }
  });
}
