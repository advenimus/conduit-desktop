/**
 * MCP Gatekeeper — controls whether the IPC socket server runs
 * based on the user's auth state and tier.
 *
 * The IPC socket server is only started when the user is signed in
 * on a plan that has `mcp_enabled: true`.
 */

import fs from 'node:fs';
import { startIpcServer, stopIpcServer } from '../ipc-server/server.js';
import { AppState } from './state.js';
import { getSocketPath, isNamedPipe } from './env-config.js';
import type { AuthState } from './auth/supabase.js';

export class McpGatekeeper {
  private ipcServerRunning = false;
  private mcpAllowed = false;

  /**
   * Evaluate whether MCP access should be allowed based on the current auth state.
   * Starts or stops the IPC server accordingly.
   */
  evaluateAccess(authState: AuthState): void {
    const shouldAllow = this.computeAccess(authState);

    if (shouldAllow === this.mcpAllowed) return; // no change

    this.mcpAllowed = shouldAllow;
    console.log(`[mcp-gatekeeper] MCP access changed: ${shouldAllow ? 'ALLOWED' : 'DENIED'}`);

    if (shouldAllow) {
      this.startServer();
    } else {
      this.stopServer();
    }

    this.notifyRenderer();
  }

  /** Returns whether MCP is currently allowed. */
  isAllowed(): boolean {
    return this.mcpAllowed;
  }

  /** Clean shutdown for app quit. */
  shutdown(): void {
    if (this.ipcServerRunning) {
      stopIpcServer();
      this.ipcServerRunning = false;
    }
  }

  private computeAccess(authState: AuthState): boolean {
    const { profile } = authState;

    // No profile → treat as local/free mode and allow. Free-tier daily quota
    // is enforced in the MCP server. Note: authService state never carries
    // authMode='local' (that's synthesized in the IPC handler for the
    // renderer). We use profile presence as the canonical signal.
    if (!profile) return true;

    // Authenticated profile loaded → check the tier feature flag
    return !!profile.tier?.features?.mcp_enabled;
  }

  private startServer(): void {
    if (this.ipcServerRunning) return;

    startIpcServer()
      .then(() => {
        this.ipcServerRunning = true;
        console.log('[mcp-gatekeeper] IPC server started');
      })
      .catch((err) => {
        console.error('[mcp-gatekeeper] Failed to start IPC server:', err);
      });
  }

  private stopServer(): void {
    if (!this.ipcServerRunning) return;

    stopIpcServer();
    this.ipcServerRunning = false;
    console.log('[mcp-gatekeeper] IPC server stopped');

    // Delete the socket file so external tools can't attempt connection
    // (Named pipes on Windows are cleaned up automatically by the OS)
    try {
      const socketPath = getSocketPath();
      if (!isNamedPipe(socketPath) && fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
        console.log('[mcp-gatekeeper] Socket file removed');
      }
    } catch (err) {
      console.warn('[mcp-gatekeeper] Failed to remove socket file:', err);
    }
  }

  private notifyRenderer(): void {
    const win = AppState.getInstance().getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('mcp:access-changed', this.mcpAllowed);
    }
  }
}
