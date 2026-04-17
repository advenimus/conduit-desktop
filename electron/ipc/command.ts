/**
 * IPC handlers for command execution.
 *
 * Handles command_execute, command_get_output, and command_cancel
 * for the "Command" entry type.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';
import type { CommandConfig, CommandCredential } from '../services/command/executor.js';

export function registerCommandHandlers(): void {
  const state = AppState.getInstance();

  // ── command_execute ─────────────────────────────────────────────────
  ipcMain.handle(
    'command_execute',
    async (_e, args: { sessionId: string; entryId: string }) => {
      const vault = state.getActiveVault();
      if (!vault.isUnlocked()) {
        throw new Error('Vault is locked');
      }

      const entry = vault.getEntry(args.entryId);
      if (!entry) {
        throw new Error('Entry not found');
      }

      const config = (entry.config ?? {}) as unknown as CommandConfig;
      if (!config.command) {
        throw new Error('No command configured');
      }

      let credential: CommandCredential | undefined;

      if (config.runAsMode === 'credential') {
        // Resolve credential from the entry's credential reference or inline creds
        const cred = vault.resolveCredential(args.entryId);
        if (cred?.username && cred?.password) {
          credential = {
            username: cred.username,
            password: cred.password,
            domain: cred.domain ?? undefined,
          };
        } else if (cred?.username) {
          throw new Error('Credential is missing a password — required for Run As User');
        } else {
          throw new Error('No credential configured — set one in the Credentials tab or switch to "Current user" mode');
        }
      }

      const session = state.commandExecutor.execute(args.sessionId, config, credential);

      const mainWindow = AppState.getInstance().getMainWindow();

      session.on('data', (data: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('command:data', {
            sessionId: args.sessionId,
            data,
          });
        }
      });

      session.on('exit', (exitCode: number) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('command:exit', {
            sessionId: args.sessionId,
            exitCode,
            status: session.status,
          });
        }
      });

      session.on('error', (error: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('command:error', {
            sessionId: args.sessionId,
            error,
          });
        }
      });

      return { sessionId: args.sessionId };
    },
  );

  // ── command_get_output ──────────────────────────────────────────────
  ipcMain.handle(
    'command_get_output',
    async (_e, args: { sessionId: string }) => {
      const result = state.commandExecutor.getOutput(args.sessionId);
      if (!result) {
        throw new Error('Session not found');
      }
      return result;
    },
  );

  // ── command_cancel ──────────────────────────────────────────────────
  ipcMain.handle(
    'command_cancel',
    async (_e, args: { sessionId: string }) => {
      state.commandExecutor.close(args.sessionId);
      return { success: true };
    },
  );
}
