/**
 * VNC IPC handler registration.
 *
 * Post-noVNC migration: the main process manages the WS-TCP bridge
 * lifecycle and relays MCP commands to/from the renderer. All VNC
 * protocol handling, rendering, and user input happens in the renderer
 * via noVNC's RFB class.
 */

import { ipcMain } from 'electron';
import { AppState } from '../services/state.js';

export function registerVncHandlers(): void {
  const vncManager = AppState.getInstance().vncManager;

  // ── Bridge lifecycle ──────────────────────────────────────────────

  ipcMain.handle(
    'vnc_connect',
    async (_e, args: {
      sessionId: string;
      host: string;
      port?: number;
      password?: string;
      username?: string;
    }) => {
      await vncManager.create(args.sessionId, {
        host: args.host,
        port: args.port ?? 5900,
        password: args.password,
        username: args.username,
      });
      const { wsUrl } = await vncManager.connect(args.sessionId);

      // Register in MCP connection registry
      const state = AppState.getInstance();
      let connName = `VNC ${args.host}`;
      try {
        if (state.getActiveVault().isUnlocked()) {
          const entries = state.getActiveVault().listEntries();
          const match = entries.find((e) => e.id === args.sessionId);
          if (match) connName = match.name;
        }
      } catch { /* Use default name */ }
      state.mcpConnections.set(args.sessionId, {
        session_id: args.sessionId,
        name: connName,
        connection_type: 'vnc',
        host: args.host,
        port: args.port ?? 5900,
        status: 'connected',
        created_at: Date.now(),
      });

      const session = vncManager.getOrThrow(args.sessionId);
      return {
        ...session.getInfo(),
        wsUrl,
        credentials: {
          password: args.password,
          username: args.username,
        },
      };
    }
  );

  ipcMain.handle('vnc_disconnect', async (_e, args: { sessionId: string }) => {
    AppState.getInstance().mcpConnections.delete(args.sessionId);
    vncManager.disconnect(args.sessionId);
  });

  /**
   * Renderer fetches WS URL + credentials for a session.
   * Used when VncView mounts (e.g., after tab switch or MCP-created session).
   */
  ipcMain.handle('vnc_get_ws_info', async (_e, args: { sessionId: string }) => {
    const session = vncManager.getOrThrow(args.sessionId);
    return {
      wsUrl: session.wsUrl,
      credentials: {
        password: session.config.password,
        username: session.config.username,
      },
    };
  });

  /**
   * Renderer reports noVNC connected.
   */
  ipcMain.handle('vnc_notify_connected', async (_e, args: {
    sessionId: string;
    width?: number;
    height?: number;
    serverName?: string;
  }) => {
    const session = vncManager.getOrThrow(args.sessionId);
    session.notifyConnected(args.width, args.height, args.serverName);
  });

  /**
   * Renderer reports noVNC disconnected.
   */
  ipcMain.handle('vnc_notify_disconnected', async (_e, args: {
    sessionId: string;
    error?: string;
  }) => {
    const session = vncManager.get(args.sessionId);
    if (session) {
      session.notifyDisconnected(args.error);
    }
  });

  /**
   * Renderer returns MCP action result.
   */
  ipcMain.handle('vnc_mcp_response', async (_e, args: {
    requestId: string;
    result?: unknown;
    error?: string;
  }) => {
    vncManager.handleMcpResponse(args.requestId, args.result, args.error);
  });

  // ── MCP tool handlers (relay to renderer) ─────────────────────────

  ipcMain.handle(
    'vnc_screenshot',
    async (_e, args: { sessionId: string; format?: string; quality?: number }) => {
      const result = await vncManager.sendMcpRequest(args.sessionId, 'screenshot', {
        format: args.format || 'png',
        quality: args.quality ?? 85,
      });
      return result;
    }
  );

  ipcMain.handle(
    'vnc_click',
    async (_e, args: { sessionId: string; x: number; y: number; button?: string }) => {
      await vncManager.sendMcpRequest(args.sessionId, 'click', {
        x: args.x,
        y: args.y,
        button: args.button || 'left',
      });
    }
  );

  ipcMain.handle('vnc_type', async (_e, args: { sessionId: string; text: string }) => {
    await vncManager.sendMcpRequest(args.sessionId, 'type', { text: args.text });
  });

  ipcMain.handle(
    'vnc_send_key',
    async (_e, args: {
      sessionId: string;
      key: string;
      modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
    }) => {
      await vncManager.sendMcpRequest(args.sessionId, 'sendKey', {
        key: args.key,
        modifiers: args.modifiers || {},
      });
    }
  );

  ipcMain.handle('vnc_get_dimensions', async (_e, args: { sessionId: string }) => {
    const session = vncManager.get(args.sessionId);
    if (!session) throw new Error(`VNC session not found: ${args.sessionId}`);
    // Return cached dimensions if session has them, otherwise ask renderer
    const dims = session.getDimensions();
    if (dims.width > 0 && dims.height > 0) return dims;
    // Fallback: ask renderer (if not yet connected, returns 0x0)
    try {
      return await vncManager.sendMcpRequest(args.sessionId, 'getDimensions', {});
    } catch {
      return dims;
    }
  });

  ipcMain.handle(
    'vnc_mouse_move',
    async (_e, args: { sessionId: string; x: number; y: number }) => {
      await vncManager.sendMcpRequest(args.sessionId, 'mouseMove', {
        x: args.x,
        y: args.y,
      });
    }
  );

  ipcMain.handle(
    'vnc_mouse_scroll',
    async (
      _e,
      args: { sessionId: string; x: number; y: number; deltaY: number; vertical?: boolean }
    ) => {
      await vncManager.sendMcpRequest(args.sessionId, 'mouseScroll', {
        x: args.x,
        y: args.y,
        deltaY: args.deltaY,
        vertical: args.vertical ?? true,
      });
    }
  );
}
