/**
 * VNC session lifecycle management.
 *
 * Post-noVNC migration: the session is a lightweight bridge lifecycle
 * manager + MCP relay. All VNC protocol handling, rendering, and input
 * happens in the renderer via noVNC's RFB class.
 *
 * The main process creates a WebSocket-to-TCP bridge so noVNC can
 * connect to the VNC server. MCP tools relay through the renderer
 * via request/response IPC.
 */

import { BrowserWindow } from 'electron';
import { VncWsBridgeManager, type WsBridge } from './ws-bridge.js';

export interface VncConfig {
  host: string;
  port: number;
  password?: string;
  username?: string;
}

export type VncSessionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting';

export interface VncSessionInfo {
  id: string;
  state: VncSessionState;
  host: string;
  port: number;
  width: number;
  height: number;
  serverName: string;
}

interface PendingMcpRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VncSession {
  readonly id: string;
  private _config: VncConfig;
  private _state: VncSessionState = 'disconnected';
  private _bridge: WsBridge | null = null;
  private _wsUrl: string | null = null;
  private _width = 0;
  private _height = 0;
  private _serverName = '';

  constructor(id: string, config: VncConfig) {
    this.id = id;
    this._config = config;
  }

  get state(): VncSessionState {
    return this._state;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get isConnected(): boolean {
    return this._state === 'connected';
  }

  get wsUrl(): string | null {
    return this._wsUrl;
  }

  get config(): VncConfig {
    return this._config;
  }

  /**
   * Create the WS-TCP bridge. The actual VNC connection happens in the
   * renderer when noVNC connects to the returned WebSocket URL.
   */
  async connect(bridgeManager: VncWsBridgeManager): Promise<{ wsUrl: string }> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: session is ${this._state}`);
    }

    this._state = 'connecting';

    try {
      this._bridge = await bridgeManager.create(
        this.id,
        this._config.host,
        this._config.port
      );
      this._wsUrl = this._bridge.wsUrl;
      // State stays 'connecting' until renderer reports noVNC connected
      return { wsUrl: this._wsUrl };
    } catch (err) {
      this._state = 'disconnected';
      this._bridge = null;
      this._wsUrl = null;
      throw err;
    }
  }

  /**
   * Called by renderer when noVNC reports connected.
   */
  notifyConnected(width?: number, height?: number, serverName?: string): void {
    this._state = 'connected';
    if (width !== undefined) this._width = width;
    if (height !== undefined) this._height = height;
    if (serverName !== undefined) this._serverName = serverName;
    console.log(`[VNC] Session ${this.id} connected: ${this._width}x${this._height} ${this._serverName}`);
  }

  /**
   * Called by renderer when noVNC disconnects.
   */
  notifyDisconnected(error?: string): void {
    this._state = 'disconnected';
    console.log(`[VNC] Session ${this.id} disconnected${error ? `: ${error}` : ''}`);

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('vnc:status', {
          sessionId: this.id,
          status: 'disconnected',
          error: error || null,
        });
      }
    }
  }

  /**
   * Tear down the bridge and disconnect.
   */
  disconnect(bridgeManager: VncWsBridgeManager): void {
    this._state = 'disconnecting';
    bridgeManager.destroy(this.id);
    this._bridge = null;
    this._wsUrl = null;
    this._state = 'disconnected';
  }

  getInfo(): VncSessionInfo {
    return {
      id: this.id,
      state: this._state,
      host: this._config.host,
      port: this._config.port,
      width: this._width,
      height: this._height,
      serverName: this._serverName,
    };
  }

  getDimensions(): { width: number; height: number } {
    return { width: this._width, height: this._height };
  }
}

// ── Session Manager ───────────────────────────────────────────────────

const MCP_REQUEST_TIMEOUT_MS = 10_000;

export class VncSessionManager {
  private _sessions: Map<string, VncSession> = new Map();
  private _bridgeManager = new VncWsBridgeManager();
  private _pendingMcpRequests: Map<string, PendingMcpRequest> = new Map();
  private _mcpRequestCounter = 0;

  get bridgeManager(): VncWsBridgeManager {
    return this._bridgeManager;
  }

  get(id: string): VncSession | undefined {
    return this._sessions.get(id);
  }

  getOrThrow(id: string): VncSession {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`VNC session not found: ${id}`);
    return session;
  }

  async create(id: string, config: VncConfig): Promise<VncSession> {
    if (this._sessions.has(id)) {
      throw new Error(`VNC session already exists: ${id}`);
    }
    const session = new VncSession(id, config);
    this._sessions.set(id, session);
    return session;
  }

  async connect(id: string): Promise<{ wsUrl: string }> {
    const session = this.getOrThrow(id);
    return session.connect(this._bridgeManager);
  }

  disconnect(id: string): void {
    const session = this._sessions.get(id);
    if (session) {
      session.disconnect(this._bridgeManager);
      this._sessions.delete(id);
    }
  }

  disconnectAll(): void {
    for (const [id] of this._sessions) {
      this.disconnect(id);
    }
    this._bridgeManager.destroyAll();
  }

  list(): VncSessionInfo[] {
    return Array.from(this._sessions.values()).map((s) => s.getInfo());
  }

  // ── MCP request/response relay ──────────────────────────────────────

  /**
   * Send an MCP action request to the renderer and wait for the response.
   * The renderer handles the action via noVNC and responds via vnc_mcp_response.
   */
  async sendMcpRequest(
    sessionId: string,
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    const session = this.getOrThrow(sessionId);
    if (session.state !== 'connected') {
      throw new Error('VNC session not connected');
    }

    const requestId = `mcp_${++this._mcpRequestCounter}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMcpRequests.delete(requestId);
        reject(new Error(`MCP request timed out: ${action}`));
      }, MCP_REQUEST_TIMEOUT_MS);

      this._pendingMcpRequests.set(requestId, { resolve, reject, timer });

      // Send to renderer
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('vnc:mcp_request', {
            requestId,
            sessionId,
            action,
            params,
          });
        }
      }
    });
  }

  /**
   * Handle MCP response from the renderer.
   */
  handleMcpResponse(requestId: string, result?: unknown, error?: string): void {
    const pending = this._pendingMcpRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingMcpRequests.delete(requestId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }
}
