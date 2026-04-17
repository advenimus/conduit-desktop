export type EntryType = 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential' | 'document' | 'command';

export type RdpResolution = "match_window" | "1920x1080" | "1280x720" | "1440x900" | "custom";

export interface SharedFolder {
  name: string;
  path: string;
  readOnly?: boolean;
}

export interface RdpEntryConfig {
  resolution: RdpResolution;
  customWidth?: number;
  customHeight?: number;
  colorDepth: 32 | 24 | 16 | 15;
  sound: "local" | "remote" | "none";
  quality: "best" | "good" | "low";
  clipboard: boolean;
  enableNla: boolean;
  hostname?: string;
  sharedFolders: SharedFolder[];
  enableHighDpi?: boolean;
}

export const DEFAULT_RDP_CONFIG: RdpEntryConfig = {
  resolution: "match_window",
  colorDepth: 32,
  sound: "local",
  quality: "good",
  clipboard: true,
  enableNla: true,
  sharedFolders: [],
};

export interface WebAutofillConfig {
  enabled: boolean;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  multiStepLogin?: boolean;
  loginUrlPattern?: string;
}

export const DEFAULT_WEB_AUTOFILL_CONFIG: WebAutofillConfig = {
  enabled: false,
};

export type WebEngineType = 'auto' | 'chromium' | 'webview2';

export interface WebEntryConfig {
  ignoreCertErrors?: boolean;
  autofill?: WebAutofillConfig;
  engine?: WebEngineType;
}

export const DEFAULT_WEB_CONFIG: WebEntryConfig = {
  ignoreCertErrors: false,
};

export interface CommandEntryConfig {
  command: string;
  args?: string;
  workingDir?: string;
  shell?: string;
  timeout?: number;
  runAsMode: 'credential' | 'current';
  guiApp?: boolean;
}

export const DEFAULT_COMMAND_CONFIG: CommandEntryConfig = {
  command: '',
  args: '',
  workingDir: '',
  shell: '',
  timeout: 0,
  runAsMode: 'credential',
  guiApp: false,
};

// ── Global Session Defaults ──────────────────────────────────────────────────
// Used in Settings dialog. Per-entry-only fields (sharedFolders, hostname,
// customWidth/Height) are excluded. "custom" resolution is per-entry only.

export type RdpGlobalResolution = Exclude<RdpResolution, "custom">;

export interface RdpGlobalDefaults {
  resolution: RdpGlobalResolution;
  colorDepth: 32 | 24 | 16 | 15;
  sound: "local" | "remote" | "none";
  quality: "best" | "good" | "low";
  clipboard: boolean;
  enableNla: boolean;
  enableHighDpi: boolean;
  displayScale: number;
}

export interface WebGlobalDefaults {
  autofillEnabled: boolean;
  ignoreCertErrors: boolean;
  engine: WebEngineType;
}

export interface TerminalGlobalDefaults {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
}

export const HARDCODED_RDP_DEFAULTS: RdpGlobalDefaults = {
  resolution: "match_window",
  colorDepth: 32,
  sound: "local",
  quality: "good",
  clipboard: true,
  enableNla: true,
  enableHighDpi: false,
  displayScale: 1.0,
};

export const HARDCODED_WEB_DEFAULTS: WebGlobalDefaults = {
  autofillEnabled: false,
  ignoreCertErrors: false,
  engine: "auto",
};

export const HARDCODED_TERMINAL_DEFAULTS: TerminalGlobalDefaults = {
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: true,
};

export type SshAuthMethod = 'key' | 'password';

export interface SshGlobalDefaults {
  authMethodWhenKeyPresent: SshAuthMethod;
}

export const HARDCODED_SSH_DEFAULTS: SshGlobalDefaults = {
  authMethodWhenKeyPresent: 'key',
};

export interface EntryMeta {
  id: string;
  name: string;
  entry_type: EntryType;
  folder_id: string | null;
  sort_order: number;
  host: string | null;
  port: number | null;
  credential_id: string | null;
  username: string | null;
  domain: string | null;
  icon: string | null;
  color: string | null;
  config: Record<string, unknown>;
  tags: string[];
  is_favorite: boolean;
  notes: string | null;
  credential_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryFull extends EntryMeta {
  password: string | null;
  private_key: string | null;
  totp_secret: string | null;
}

export interface FolderData {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolvedCredential {
  source: 'explicit' | 'inline' | 'inherited';
  source_entry_id: string | null;
  source_folder_id: string | null;
  username: string | null;
  password: string | null;
  domain: string | null;
  private_key: string | null;
}

export interface PasswordHistoryEntry {
  id: string;
  entry_id: string;
  username: string | null;
  password: string | null;
  changed_at: string;
  changed_by: string | null;
}
