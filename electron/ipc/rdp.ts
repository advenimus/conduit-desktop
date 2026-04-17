/**
 * RDP IPC handlers for Electron main process.
 *
 * Registers handlers for: rdp_connect, rdp_disconnect, rdp_screenshot,
 * rdp_click, rdp_type, rdp_send_key, rdp_mouse_move, rdp_mouse_drag,
 * rdp_get_dimensions, rdp_mouse_down, rdp_mouse_up, rdp_mouse_scroll,
 * rdp_key_down, rdp_key_up.
 */

import { ipcMain } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RdpEngineConfig, SharedFolder } from '../services/rdp/engine.js';
import { AppState } from '../services/state.js';
import type { ImageFormat } from '../services/rdp/framebuffer.js';
import { readSettings } from './settings.js';
import { isFreeRdpAvailable, ensureFreeRdpReady } from '../services/rdp/engines/factory.js';
import { getDataDir } from '../services/env-config.js';

const RDP_LOG = join(getDataDir(), 'rdp-debug.log');
function rdpLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(RDP_LOG, line); } catch { /* ignore */ }
  console.log(msg);
}

export function registerRdpHandlers(): void {
  const rdpManager = AppState.getInstance().rdpManager;
  /** Helper to get the main BrowserWindow */
  function getMainWindow() {
    return AppState.getInstance().getMainWindow();
  }

  // ── rdp_connect ──────────────────────────────────────────────────────

  ipcMain.handle('rdp_connect', async (_e, args: {
    sessionId: string;
    host: string;
    hostname?: string;
    port?: number;
    username: string;
    password: string;
    domain?: string;
    width?: number;
    height?: number;
    enableNla?: boolean;
    skipCertVerification?: boolean;
    sharedFolders?: SharedFolder[];
    colorDepth?: 32 | 24 | 16 | 15;
    performanceMode?: 'best' | 'balanced' | 'fast';
    enableBitmapCache?: boolean;
    enableServerPointer?: boolean;
    frameRate?: 30 | 60;
    desktopScaleFactor?: number;
    deviceScaleFactor?: number;
    enableClipboard?: boolean;
  }) => {
    const config: RdpEngineConfig = {
      host: args.host,
      hostname: args.hostname,
      port: args.port ?? 3389,
      username: args.username,
      password: args.password,
      domain: args.domain,
      width: args.width ?? 1920,
      height: args.height ?? 1080,
      enableNla: args.enableNla ?? true,
      skipCertVerification: args.skipCertVerification ?? false,
      sharedFolders: args.sharedFolders,
      colorDepth: args.colorDepth,
      performanceMode: args.performanceMode,
      enableBitmapCache: args.enableBitmapCache,
      enableServerPointer: args.enableServerPointer,
      frameRate: args.frameRate,
      desktopScaleFactor: args.desktopScaleFactor,
      deviceScaleFactor: args.deviceScaleFactor,
      enableClipboard: args.enableClipboard,
    };

    rdpLog(`[RDP] rdp_connect called. sharedFolders=${JSON.stringify(config.sharedFolders)}`);
    rdpLog(`[RDP] Full config: host=${config.host}, port=${config.port}, width=${config.width}, height=${config.height}, enableNla=${config.enableNla}, desktopSF=${config.desktopScaleFactor ?? 100}, deviceSF=${config.deviceScaleFactor ?? 100}`);

    // Ensure FreeRDP helper binary is available (auto-builds if missing)
    await ensureFreeRdpReady();

    const session = rdpManager.create(args.sessionId, config);

    const win = getMainWindow();
    if (win) {
      session.setWindow(win);
    }

    await session.connect();

    // Register in MCP connection registry so AI/MCP tools can see UI-opened sessions
    const state = AppState.getInstance();
    let connName = `RDP ${args.host}`;
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
      connection_type: 'rdp',
      host: args.host,
      port: args.port ?? 3389,
      status: 'connected',
      created_at: Date.now(),
    });

    // Return server-negotiated dimensions (may differ from requested)
    const dims = session.getDimensions();
    return {
      sessionId: args.sessionId,
      width: dims.width,
      height: dims.height,
    };
  });

  // ── rdp_disconnect ───────────────────────────────────────────────────

  ipcMain.handle('rdp_disconnect', async (_e, args: { sessionId: string }) => {
    AppState.getInstance().mcpConnections.delete(args.sessionId);
    await rdpManager.remove(args.sessionId);
  });

  // ── rdp_screenshot ───────────────────────────────────────────────────

  ipcMain.handle('rdp_screenshot', async (_e, args: {
    sessionId: string;
    format?: 'png' | 'jpeg';
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    if (!session.isConnected()) throw new Error('RDP session not connected');

    const fmt: ImageFormat = args.format === 'jpeg'
      ? { type: 'jpeg', quality: args.quality ?? 85 }
      : { type: 'png' };

    let result: { buffer: Buffer; width: number; height: number };
    if (args.region) {
      const r = args.region;
      result = await session.screenshotRegion(r.x, r.y, r.width, r.height, fmt);
    } else {
      result = await session.screenshot(fmt);
    }

    return result.buffer.toString('base64');
  });

  // ── rdp_click ────────────────────────────────────────────────────────

  ipcMain.handle('rdp_click', async (_e, args: {
    sessionId: string;
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    doubleClick?: boolean;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    if (!session.isConnected()) throw new Error('RDP session not connected');

    const button = args.button || 'left';
    if (args.doubleClick) {
      session.mouseDoubleClick(args.x, args.y, button);
    } else {
      session.mouseClick(args.x, args.y, button);
    }
  });

  // ── rdp_mouse_down ───────────────────────────────────────────────────

  ipcMain.handle('rdp_mouse_down', async (_e, args: {
    sessionId: string;
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.mouseDown(args.x, args.y, args.button || 'left');
  });

  // ── rdp_mouse_up ─────────────────────────────────────────────────────

  ipcMain.handle('rdp_mouse_up', async (_e, args: {
    sessionId: string;
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.mouseUp(args.x, args.y, args.button || 'left');
  });

  // ── rdp_mouse_move ───────────────────────────────────────────────────

  ipcMain.handle('rdp_mouse_move', async (_e, args: {
    sessionId: string;
    x: number;
    y: number;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.mouseMove(args.x, args.y);
  });

  // ── rdp_mouse_drag ───────────────────────────────────────────────────

  ipcMain.handle('rdp_mouse_drag', async (_e, args: {
    sessionId: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    button?: 'left' | 'right' | 'middle';
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    if (!session.isConnected()) throw new Error('RDP session not connected');

    session.mouseDrag(args.fromX, args.fromY, args.toX, args.toY, args.button || 'left');
  });

  // ── rdp_mouse_scroll ─────────────────────────────────────────────────

  ipcMain.handle('rdp_mouse_scroll', async (_e, args: {
    sessionId: string;
    x: number;
    y: number;
    deltaY: number;
    vertical?: boolean;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.mouseScroll(args.x, args.y, args.deltaY, args.vertical ?? true);
  });

  // ── rdp_type ─────────────────────────────────────────────────────────

  ipcMain.handle('rdp_type', async (_e, args: {
    sessionId: string;
    text: string;
    delayMs?: number;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    if (!session.isConnected()) throw new Error('RDP session not connected');

    await session.typeText(args.text, args.delayMs ?? 20);
  });

  // ── rdp_send_key ─────────────────────────────────────────────────────

  ipcMain.handle('rdp_send_key', async (_e, args: {
    sessionId: string;
    key: string;
    modifiers?: string[];
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    if (!session.isConnected()) throw new Error('RDP session not connected');

    session.sendKey(args.key, args.modifiers || []);
  });

  // ── rdp_key_down ─────────────────────────────────────────────────────

  ipcMain.handle('rdp_key_down', async (_e, args: {
    sessionId: string;
    key: string;
    code: string;
    modifiers?: string[];
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.keyDown(args.key, args.code, args.modifiers || []);
  });

  // ── rdp_key_up ───────────────────────────────────────────────────────

  ipcMain.handle('rdp_key_up', async (_e, args: {
    sessionId: string;
    key: string;
    code: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);
    session.keyUp(args.key, args.code);
  });

  // ── rdp_get_dimensions ───────────────────────────────────────────────

  ipcMain.handle('rdp_get_dimensions', async (_e, args: { sessionId: string }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) throw new Error(`RDP session not found: ${args.sessionId}`);

    return session.getDimensions();
  });

  // ── rdp_request_frame ─────────────────────────────────────────────

  ipcMain.handle('rdp_request_frame', async (_e, args: { sessionId: string }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session || !session.isConnected()) return; // Silently ignore if not available

    session.sendFullFrame();
  });

  // ── rdp_engine_info ──────────────────────────────────────────────

  ipcMain.handle('rdp_engine_info', async () => {
    return {
      freerdpAvailable: isFreeRdpAvailable(),
    };
  });

  // ── rdp_clipboard_send ───────────────────────────────────────────

  ipcMain.handle('rdp_clipboard_send', async (_e, args: {
    sessionId: string;
    text: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session || !session.isConnected()) return;
    session.sendClipboard(args.text);
  });

  // ── rdp_clipboard_sync ───────────────────────────────────────────

  ipcMain.handle('rdp_clipboard_sync', async (_e, args: {
    sessionId: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session || !session.isConnected()) return;
    session.syncLocalClipboardToRemote();
  });

  // ── rdp_clipboard_files_request ─────────────────────────────────

  ipcMain.handle('rdp_clipboard_files_request', async (_e, args: {
    sessionId: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session || !session.isConnected()) return;
    session.requestRemoteFiles();
  });

  // ── rdp_clipboard_files_dismiss ─────────────────────────────────

  ipcMain.handle('rdp_clipboard_files_dismiss', async (_e, args: {
    sessionId: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) return;
    session.dismissRemoteFiles();
  });

  // ── rdp_clipboard_files_info ──────────────────────────────────

  ipcMain.handle('rdp_clipboard_files_info', async (_e, args: {
    sessionId: string;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session) return { files: [] };
    return { files: session.getRemoteFiles() };
  });

  // ── rdp_resize ────────────────────────────────────────────────────

  ipcMain.handle('rdp_resize', async (_e, args: {
    sessionId: string;
    width: number;
    height: number;
    desktopScaleFactor?: number;
    deviceScaleFactor?: number;
  }) => {
    const session = rdpManager.get(args.sessionId);
    if (!session || !session.isConnected()) return;

    await session.resize(args.width, args.height, args.desktopScaleFactor, args.deviceScaleFactor);
  });
}
