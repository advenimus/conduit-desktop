/**
 * Global application state for the Electron main process.
 *
 * Holds references to all service managers and the unified vault.
 */

import { BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir as resolveDataDir } from './env-config.js';
import { ChatStore } from './chat/chat-store.js';
import { ConduitVault } from './vault/vault.js';
import { CloudSyncService } from './vault/cloud-sync.js';
import { LocalBackupService } from './vault/local-backup.js';
import { ChatCloudSyncService } from './chat/chat-cloud-sync.js';
import { TerminalManager } from './terminal/manager.js';
import { WebSessionManager } from './web/manager.js';
import { RdpSessionManager } from './rdp/session.js';
import { VncSessionManager } from './vnc/session.js';
import { readSettings } from '../ipc/settings.js';
import { AuthService } from './auth/supabase.js';
import { EngineManager } from './ai/engines/engine-manager.js';
import { ClaudeCodeEngine } from './ai/engines/claude-code-engine.js';
import { CodexEngine } from './ai/engines/codex-engine.js';
import { TeamService } from './team/team-service.js';
import { TeamVaultManager } from './vault/team-vault-manager.js';
import { VaultLockService } from './vault/vault-lock.js';
import { NetworkLockService } from './vault/network-lock.js';
import { McpGatekeeper } from './mcp-gatekeeper.js';
import { CommandExecutor } from './command/executor.js';
import { ToolApprovalService } from './tool-approval.js';
import { NetworkVaultWatcher } from './vault/network-watcher.js';

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

// ---------- ApprovalManager ----------

export interface PendingApproval {
  credentialId: string;
  credentialName: string;
  purpose: string;
  resolve: (approved: boolean) => void;
}

export interface ApprovalInfo {
  credential_id: string;
  credential_name: string;
  purpose: string;
}

export class ApprovalManager {
  private pending: Map<string, PendingApproval> = new Map();

  addPending(requestId: string, approval: PendingApproval): void {
    this.pending.set(requestId, approval);
  }

  resolve(requestId: string, approved: boolean): boolean {
    const approval = this.pending.get(requestId);
    if (!approval) return false;
    this.pending.delete(requestId);
    approval.resolve(approved);
    return true;
  }

  getPendingInfo(requestId: string): ApprovalInfo | null {
    const approval = this.pending.get(requestId);
    if (!approval) return null;
    return {
      credential_id: approval.credentialId,
      credential_name: approval.credentialName,
      purpose: approval.purpose,
    };
  }
}

// ---------- AppState ----------

export class AppState {
  sessions: Map<string, Session> = new Map();
  mcpConnections: Map<string, McpConnection> = new Map();
  vault: ConduitVault;
  chatStore: ChatStore;
  cloudSync: CloudSyncService;
  localBackup: LocalBackupService;
  chatCloudSync: ChatCloudSyncService;
  terminalManager: TerminalManager;
  webManager: WebSessionManager;
  rdpManager: RdpSessionManager;
  vncManager: VncSessionManager;
  engineManager: EngineManager;
  approvalManager: ApprovalManager;
  toolApproval: ToolApprovalService;
  authService: AuthService;
  teamService: TeamService;
  teamVaultManager: TeamVaultManager;
  vaultLock: VaultLockService;
  networkLock: NetworkLockService;
  vaultWatcher: NetworkVaultWatcher | null = null;
  mcpGatekeeper: McpGatekeeper;
  commandExecutor: CommandExecutor;
  currentVaultPath: string;
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
    this.toolApproval = new ToolApprovalService();
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
    this.chatCloudSync = new ChatCloudSyncService(this.authService);

    // Register engine adapters
    this.engineManager.register(new ClaudeCodeEngine(this.engineManager));
    this.engineManager.register(new CodexEngine(this.engineManager));

    // Wire MCP gatekeeper to auth state changes
    this.authService.onStateChange((authState) => {
      this.mcpGatekeeper.evaluateAccess(authState);
    });

    // Ensure data directory exists
    const dataDir = this.getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
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

  /** Switch to a different vault file */
  switchVault(filePath: string): void {
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
