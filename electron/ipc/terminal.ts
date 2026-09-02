/**
 * IPC handlers for terminal operations.
 *
 * Port of src-tauri/src/commands/terminal.rs
 *
 * Channel names match the original Tauri command names so
 * the frontend `invoke()` calls work without modification.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import type { SshAuth, SshConfig } from '../services/ssh/client.js';
import { resolveSshAuth, resolveSshAuthSystem } from '../services/ssh/resolve-auth.js';
import { readSettings } from './settings.js';
import { getDataDir, getEnvConfig } from '../services/env-config.js';
import { getSocketPath } from '../ipc-server/server.js';
import { getMcpServerPath } from '../services/agent-instructions.js';
import {
  isKnownEngineType,
  resolveLaunchCommand,
  writeProjectMcpFiles,
} from '../services/ai/cli-harnesses.js';
import { resolveAgentWorkingDir } from '../services/ai/agent-working-dir.js';
import type { EngineType } from '../services/ai/engines/engine.js';

export function registerTerminalHandlers(): void {
  const state = AppState.getInstance();

  // ── local_shell_create ───────────────────────────────────────────
  ipcMain.handle(
    'local_shell_create',
    async (_e, args?: { shellType?: string; cwd?: string }) => {
      const sessionId = state.terminalManager.createLocalShell(
        args?.shellType,
        args?.cwd,
      );

      // Register in MCP connection registry so MCP tools can see UI-opened shells
      state.mcpConnections.set(sessionId, {
        session_id: sessionId,
        name: 'Local Shell',
        connection_type: 'local_shell',
        host: null,
        port: null,
        status: 'connected',
        created_at: Date.now(),
      });

      return sessionId;
    },
  );

  // ── get_agent_working_dir ────────────────────────────────────────
  // Returns the resolved path for a given agent engine type.
  ipcMain.handle(
    'get_agent_working_dir',
    async (_e, args: { engineType: EngineType }) => {
      if (!isKnownEngineType(args.engineType)) {
        throw new Error(`Invalid engine type: ${args.engineType}`);
      }
      const { cwd } = resolveAgentWorkingDir({
        engineType: args.engineType,
        dataDir: getDataDir(),
      });
      return cwd;
    },
  );

  // ── agent_terminal_create ────────────────────────────────────────
  // Creates a PTY running a CLI agent.
  // Does NOT register in mcpConnections — sidebar-only terminals.
  ipcMain.handle(
    'agent_terminal_create',
    async (_e, args: { engineType: EngineType; cwd?: string | null }) => {
      const { engineType, cwd: explicitCwd } = args;
      if (!isKnownEngineType(engineType)) {
        throw new Error(`Invalid engine type: ${engineType}`);
      }

      const { command, args: launchArgs } = await resolveLaunchCommand(engineType);
      const settings = readSettings();
      const { cwd, usedManagedAgentDir } = resolveAgentWorkingDir({
        engineType,
        explicitCwd,
        defaultWorkingDirectory: settings.default_working_directory,
        dataDir: getDataDir(),
      });

      if (usedManagedAgentDir) {
        writeProjectMcpFiles(
          cwd,
          engineType,
          getMcpServerPath(),
          getSocketPath(),
          getEnvConfig().environment,
        );
      }

      const sessionId = state.terminalManager.createAgentTerminal({
        command,
        args: launchArgs,
        cwd,
      });
      return sessionId;
    },
  );

  // ── ssh_session_create ─────────────────────────────────────────
  // Creates an actual SSH terminal session in the TerminalManager.
  // Resolves credentials from vault if credential_id is provided,
  // otherwise uses inline username/password.
  ipcMain.handle(
    'ssh_session_create',
    async (_e, args: {
      host: string;
      port?: number;
      credentialId?: string | null;
      username?: string | null;
      password?: string | null;
      privateKey?: string | null;
      sshAuthMethod?: string | null;
    }) => {
      const { host, port, credentialId, username, password, privateKey, sshAuthMethod } = args;

      let auth: SshAuth;

      if (credentialId) {
        // Resolve credential from vault
        const cred = state.getActiveVault().getCredential(credentialId);
        if (!cred) {
          throw new Error(`Credential not found: ${credentialId}`);
        }
        auth = resolveSshAuth(cred, sshAuthMethod);
      } else if (username) {
        auth = resolveSshAuth({
          username,
          password: password || null,
          private_key: privateKey || null,
        }, sshAuthMethod);
      } else {
        auth = resolveSshAuthSystem();
      }

      const sshPort = port ?? 22;
      const sessionId = await state.terminalManager.createSshSession({
        host,
        port: sshPort,
        auth,
      });

      // Register in MCP connection registry so MCP tools can see UI-opened sessions
      let connName = `SSH ${host}`;
      try {
        if (state.getActiveVault().isUnlocked()) {
          const entries = state.getActiveVault().listEntries();
          const match = entries.find(
            (e) => e.host === host && (e.port ?? 22) === sshPort && e.entry_type === 'ssh',
          );
          if (match) connName = match.name;
        }
      } catch {
        // Use default name
      }
      state.mcpConnections.set(sessionId, {
        session_id: sessionId,
        name: connName,
        connection_type: 'ssh',
        host,
        port: sshPort,
        status: 'connected',
        created_at: Date.now(),
      });

      return sessionId;
    },
  );

  // ── terminal_start ───────────────────────────────────────────────
  // Called by the frontend after setting up its event listener.
  ipcMain.handle(
    'terminal_start',
    async (_e, args?: { sessionId?: string }) => {
      const sessionId = args?.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      state.terminalManager.startReading(sessionId);
    },
  );

  // ── terminal_write ───────────────────────────────────────────────
  ipcMain.handle(
    'terminal_write',
    async (_e, args?: { sessionId?: string; data?: number[] }) => {
      const sessionId = args?.sessionId;
      const data = args?.data;
      if (!sessionId) throw new Error('sessionId is required');
      if (!data) throw new Error('data is required');
      state.terminalManager.write(sessionId, new Uint8Array(data));
    },
  );

  // ── terminal_resize ──────────────────────────────────────────────
  ipcMain.handle(
    'terminal_resize',
    async (_e, args?: { sessionId?: string; cols?: number; rows?: number }) => {
      const sessionId = args?.sessionId;
      const cols = args?.cols;
      const rows = args?.rows;
      if (!sessionId) throw new Error('sessionId is required');
      if (cols == null || rows == null) throw new Error('cols and rows are required');
      state.terminalManager.resize(sessionId, cols, rows);
    },
  );

  // ── terminal_read_buffer ─────────────────────────────────────────
  ipcMain.handle(
    'terminal_read_buffer',
    async (_e, args?: { sessionId?: string; lines?: number }) => {
      const sessionId = args?.sessionId;
      const lines = args?.lines ?? 100;
      if (!sessionId) throw new Error('sessionId is required');
      return state.terminalManager.readBuffer(sessionId, lines);
    },
  );

  // ── terminal_close ───────────────────────────────────────────────
  ipcMain.handle(
    'terminal_close',
    async (_e, args?: { sessionId?: string }) => {
      const sessionId = args?.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      state.terminalManager.close(sessionId);
      state.mcpConnections.delete(sessionId);
    },
  );

  // ── terminal_is_connected ────────────────────────────────────────
  ipcMain.handle(
    'terminal_is_connected',
    async (_e, args?: { sessionId?: string }) => {
      const sessionId = args?.sessionId;
      if (!sessionId) throw new Error('sessionId is required');
      return state.terminalManager.isConnected(sessionId);
    },
  );

  // ── terminal_list ────────────────────────────────────────────────
  ipcMain.handle('terminal_list', async () => {
    return state.terminalManager.listSessions();
  });
}
