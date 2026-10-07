/**
 * Global application state for the Electron main process.
 *
 * Holds references to all service managers and the unified vault.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getDataDir as resolveDataDir } from './env-config.js';
import { ChatStore } from './chat/chat-store.js';
import { ConduitVault } from './vault/vault.js';
import { CloudSyncService } from './vault/cloud-sync.js';
import { LocalBackupService } from './vault/local-backup.js';
import { TerminalManager } from './terminal/manager.js';
import { WebSessionManager } from './web/manager.js';
import { RdpSessionManager } from './rdp/session.js';
import { VncSessionManager } from './vnc/session.js';
import { readSettings, writeSettings, type AppSettings } from '../ipc/settings.js';
import { AuthService, type AuthState } from './auth/supabase.js';
import { AppSyncManager } from './sync/app-sync-manager.js';
import { VAULT_PATH_CHANGED_EVENT, type SharedPathChange } from './sync/app-sync-binding.js';
import { withMovedRecentVault } from '../ipc/recent-vaults.js';
import { withStartupPathMoved } from '../ipc/startup-vault-core.js';
import { VaultAccessProxy } from './vault/vault-access-proxy.js';
import type { LockedReason } from './vault-session/host.js';
import { EngineManager } from './ai/engines/engine-manager.js';
import { ClaudeCodeEngine } from './ai/engines/claude-code-engine.js';
import { CodexEngine } from './ai/engines/codex-engine.js';
import { TeamService } from './team/team-service.js';
import { TeamVaultManager } from './vault/team-vault-manager.js';
import { VaultLockService } from './vault/vault-lock.js';
import { NetworkLockService } from './vault/network-lock.js';
import { McpGatekeeper } from './mcp-gatekeeper.js';
import { CommandExecutor } from './command/executor.js';
import { NetworkVaultWatcher } from './vault/network-watcher.js';
import { ApprovalManager } from './reveal-approvals.js';

// ---------- types ----------

export interface Session {
  id: string;
  connection_id: string;
  type: string;
  title: string;
  is_connected: boolean;
}

/** Tracks an active MCP connection (SSH session, local shell, etc.) */
export interface McpConnection {
  session_id: string;
  name: string;
  connection_type: string;
  host: string | null;
  port: number | null;
  status: 'connected' | 'disconnected';
  created_at: number;
}

export { ApprovalManager, type RevealRequestInfo } from './reveal-approvals.js';

// ---------- AppState ----------

export class AppState {
  sessions: Map<string, Session> = new Map();
  mcpConnections: Map<string, McpConnection> = new Map();
  vault: ConduitVault;
  chatStore: ChatStore;
  cloudSync: CloudSyncService;
  localBackup: LocalBackupService;
  terminalManager: TerminalManager;
  webManager: WebSessionManager;
  rdpManager: RdpSessionManager;
  vncManager: VncSessionManager;
  engineManager: EngineManager;
  approvalManager: ApprovalManager;
  authService: AuthService;
  teamService: TeamService;
  teamVaultManager: TeamVaultManager;
  vaultLock: VaultLockService;
  networkLock: NetworkLockService;
  vaultWatcher: NetworkVaultWatcher | null = null;
  mcpGatekeeper: McpGatekeeper;
  commandExecutor: CommandExecutor;
  currentVaultPath: string;
  /** Soft lock, open-in-place and create-in-place handlers (installed by the vault IPC module). */
  readonly vaultAccess = new VaultAccessProxy();
  /** Personal-vault sync: leases, working copies and the merge engine (team vaults never use it). */
  readonly appSync: AppSyncManager;
  /** Why the personal vault is locked when another device took it over (MCP and IPC errors). */
  personalLockReason: LockedReason | null = null;
  /** Master password held in memory while vault is unlocked (for cloud sync re-encryption). */
  private _masterPasswordBuf: Buffer | null = null;

  get currentMasterPassword(): string | null {
    return this._masterPasswordBuf ? this._masterPasswordBuf.toString('utf-8') : null;
  }

  set currentMasterPassword(value: string | null) {
    if (this._masterPasswordBuf) {
      this._masterPasswordBuf.fill(0);
      this._masterPasswordBuf = null;
    }
    if (value) {
      this._masterPasswordBuf = Buffer.from(value, 'utf-8');
    }
  }

  private static instance: AppState | null = null;
  private _mainWindow: BrowserWindow | null = null;

  /** Set the main window reference. Must be called after window creation. */
  setMainWindow(win: BrowserWindow): void {
    this._mainWindow = win;
    win.on('closed', () => { this._mainWindow = null; });
  }

  /** Get the main window (not the overlay or picker windows). */
  getMainWindow(): BrowserWindow | null {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) return this._mainWindow;
    return null;
  }

  private constructor() {
    const getMainWindow = () => this.getMainWindow();

    // Use last vault path from settings if it exists on disk
    let vaultPath = this.getDefaultVaultPath();
    try {
      const settings = readSettings();
      if (settings.last_vault_path) {
        if (fs.existsSync(settings.last_vault_path)) {
          vaultPath = settings.last_vault_path;
        } else {
          console.warn('[Conduit] Last vault path not found on disk:', settings.last_vault_path);
        }
      }
    } catch (err) {
      console.error('[Conduit] Failed to read settings for vault path:', err);
    }

    this.currentVaultPath = vaultPath;
    this.vault = new ConduitVault(this.currentVaultPath);
    this.chatStore = new ChatStore(path.join(this.getDataDir(), 'conduit-chat.db'));
    this.terminalManager = new TerminalManager(getMainWindow);
    this.webManager = new WebSessionManager(getMainWindow);
    this.rdpManager = new RdpSessionManager();
    this.vncManager = new VncSessionManager();
    this.engineManager = new EngineManager();
    this.approvalManager = new ApprovalManager();
    this.authService = new AuthService();
    this.teamService = new TeamService(this.authService);
    this.teamVaultManager = new TeamVaultManager(this.authService);
    this.vaultLock = new VaultLockService(this.authService);
    this.teamVaultManager.setVaultLockService(this.vaultLock);
    this.networkLock = new NetworkLockService();
    this.mcpGatekeeper = new McpGatekeeper();
    this.commandExecutor = new CommandExecutor();
    this.cloudSync = new CloudSyncService(this.authService);
    this.localBackup = new LocalBackupService();

    // Register engine adapters
    this.engineManager.register(new ClaudeCodeEngine(this.engineManager));
    this.engineManager.register(new CodexEngine(this.engineManager));

    // Wire MCP gatekeeper to auth state changes
    this.authService.onStateChange((authState) => {
      this.mcpGatekeeper.evaluateAccess(authState);
    });

    this.appSync = this.createAppSync();
    this.watchSignOut();

    // Ensure data directory exists
    const dataDir = this.getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /** No IO until start() (main.ts, after app ready). */
  private createAppSync(): AppSyncManager {
    return new AppSyncManager({
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      dataDir: this.getDataDir(),
      home: os.homedir(),
      env: process.env,
      vault: () => this.vault,
      auth: this.authService,
      settings: {
        read: () => readSettings() as unknown as Record<string, unknown>,
        update: (patch) => writeSettings({ ...readSettings(), ...patch } as AppSettings),
      },
      busy: {
        terminals: () => this.terminalManager.countSessions().connections,
        rdp: () => this.rdpManager.list().length,
        vnc: () => this.vncManager.list().length,
        web: () => this.webManager.listSessions().length,
        commands: () => this.commandExecutor.runningCount(),
        agentJobs: () => this.engineManager.runningTurns() + this.terminalManager.countSessions().agents,
        mcpJobs: () => this.mcpConnections.size,
      },
      access: this.vaultAccess,
      onSharedPathChanged: (change) => this.followSharedFile(change),
    });
  }

  /** The sync engine moved the open vault to another file (spec 5.9): vault, settings and renderer follow. */
  private followSharedFile({ from, to }: SharedPathChange): void {
    this.vault.rebindSharedPath(to);
    this.currentVaultPath = to;
    try {
      writeSettings(withStartupPathMoved(withMovedRecentVault(readSettings(), from, to), from, to));
    } catch (err) {
      console.error('[vault] could not record the moved vault file in settings', { name: err instanceof Error ? err.name : 'Error' });
    }
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(VAULT_PATH_CHANGED_EVENT, { path: to });
  }

  /**
   * Signed in -> signed out while a vault is open: owner claims apply. auth_sign_out already
   * released the lease before signing out; the runtime runs that release once, so this call only
   * covers forced sign-outs (MFA required, suspension) and refreshes the badge.
   */
  private watchSignOut(): void {
    let previousUserId = this.authService.getAuthState().user?.id ?? null;
    this.authService.onStateChange((authState: AuthState) => {
      const userId = authState.user?.id ?? null;
      if (previousUserId !== null && userId === null) {
        this.appSync.signedOut().catch((err: unknown) => {
          console.error('[vault-session] sign-out release failed', { name: err instanceof Error ? err.name : 'Error' });
        });
      }
      previousUserId = userId;
    });
  }

  /** Singleton accessor */
  static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState();
    }
    return AppState.instance;
  }

  /** Path to the app's persistent data directory */
  getDataDir(): string {
    return resolveDataDir();
  }

  /** Path to the default vault file */
  getDefaultVaultPath(): string {
    return path.join(this.getDataDir(), 'default.conduit');
  }

  /**
   * Get the currently active vault.
   * Returns the team vault if one is open, otherwise the personal vault.
   */
  getActiveVault(): ConduitVault {
    return this.teamVaultManager.getActiveVault() ?? this.vault;
  }

  /** Close all active sessions across every session manager. */
  async closeAllSessions(): Promise<void> {
    this.terminalManager.dispose();
    await this.rdpManager.closeAll();
    this.vncManager.disconnectAll();
    this.webManager.destroyAll();
    this.commandExecutor.closeAll();
    this.mcpConnections.clear();
    this.sessions.clear();
  }

  /** Switch to a different vault file (callers lock the open vault first: lockVaultFromMain). */
  switchVault(filePath: string): void {
    if (this.appSync.isOpen() || this.appSync.isOpening()) {
      throw new Error('Lock the open vault before switching');
    }
    // Lock current vault if open
    this.vault.lock();
    this.currentVaultPath = filePath;
    this.vault = new ConduitVault(filePath);
  }

  /** Check if legacy vault files exist (for migration) */
  hasLegacyVault(): boolean {
    const dataDir = this.getDataDir();
    return fs.existsSync(path.join(dataDir, 'vault.db')) &&
           fs.existsSync(path.join(dataDir, 'vault.salt'));
  }

  /** Path to legacy connections JSON (for migration) */
  getLegacyConnectionsPath(): string {
    return path.join(this.getDataDir(), 'connections.json');
  }
}
