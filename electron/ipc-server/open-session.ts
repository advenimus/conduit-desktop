/**
 * Shared session-creation helpers for MCP connection tools.
 *
 * Both `connection_open` (manual host/port/credential params) and
 * `connection_open_entry` (open a saved vault entry by id) resolve their
 * parameters differently, but the actual session lifecycle — create via the
 * protocol manager, attach the window, connect, register in the MCP connection
 * registry, and notify the renderer to spawn a tab — is identical. These
 * helpers own that shared lifecycle so the two handlers stay in lock-step.
 */

import { randomUUID } from 'node:crypto';
import { AppState } from '../services/state.js';
import type { SshAuth } from '../services/ssh/client.js';
import type { RdpEngineConfig } from '../services/rdp/engine.js';
import { ensureFreeRdpReady } from '../services/rdp/engines/factory.js';

// Pure RDP-entry → engine-config translation lives in its own electron-free
// module so it can be unit-tested in isolation; re-exported here for callers.
export { buildRdpEngineConfigFromEntry } from './rdp-entry-config.js';

export interface OpenedSession {
  session_id: string;
  connection_type: 'ssh' | 'rdp' | 'vnc';
  host: string;
  port: number;
  status: string;
  width?: number;
  height?: number;
}

/** Notify the renderer to create a tab for an MCP-created session. */
function notifyRendererTab(
  sessionId: string,
  type: 'ssh' | 'rdp' | 'vnc',
  title: string,
  host: string,
  port: number,
): void {
  const mainWindow = AppState.getInstance().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:mcp-created', { sessionId, type, title, host, port });
  }
}

/** Register a freshly-opened session so MCP/AI tools can see it via connection_list. */
function registerMcpConnection(
  state: AppState,
  sessionId: string,
  connectionType: 'ssh' | 'rdp' | 'vnc',
  name: string,
  host: string,
  port: number,
  gatewayId?: string,
): void {
  state.mcpConnections.set(sessionId, {
    session_id: sessionId,
    name,
    connection_type: connectionType,
    host,
    port,
    status: 'connected',
    created_at: Date.now(),
    ...(gatewayId ? { gateway_id: gatewayId } : {}),
  });
}

/** Open an SSH terminal session and wire it into the MCP registry + UI. */
export async function openSshSession(
  state: AppState,
  opts: { host: string; port: number; auth: SshAuth; name: string },
): Promise<OpenedSession> {
  const sessionId = await state.terminalManager.createSshSession({
    host: opts.host,
    port: opts.port,
    auth: opts.auth,
  });
  state.terminalManager.startReading(sessionId);

  registerMcpConnection(state, sessionId, 'ssh', opts.name, opts.host, opts.port);
  notifyRendererTab(sessionId, 'ssh', opts.name, opts.host, opts.port);

  return {
    session_id: sessionId,
    connection_type: 'ssh',
    host: opts.host,
    port: opts.port,
    status: 'connected',
  };
}

/** Open an RDP session from a fully-built engine config and wire it into the MCP registry + UI. */
export async function openRdpSession(
  state: AppState,
  opts: { config: RdpEngineConfig; name: string; gatewayId?: string },
): Promise<OpenedSession> {
  // Ensure FreeRDP helper binary is available (auto-builds if missing)
  await ensureFreeRdpReady();

  const sessionId = randomUUID();
  const session = state.rdpManager.create(sessionId, opts.config);

  // Set window for frame events
  const mainWindow = AppState.getInstance().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    session.setWindow(mainWindow);
  }

  await session.connect();

  const host = opts.config.host;
  const port = opts.config.port;
  registerMcpConnection(state, sessionId, 'rdp', opts.name, host, port, opts.gatewayId);
  notifyRendererTab(sessionId, 'rdp', opts.name, host, port);

  const dims = session.getDimensions();
  return {
    session_id: sessionId,
    connection_type: 'rdp',
    host,
    port,
    status: 'connected',
    width: dims.width,
    height: dims.height,
  };
}

/** Open a VNC session and wire it into the MCP registry + UI. */
export async function openVncSession(
  state: AppState,
  opts: { host: string; port: number; password?: string; username?: string; name: string },
): Promise<OpenedSession> {
  const sessionId = randomUUID();
  await state.vncManager.create(sessionId, {
    host: opts.host,
    port: opts.port,
    password: opts.password,
    username: opts.username,
  });
  await state.vncManager.connect(sessionId);

  registerMcpConnection(state, sessionId, 'vnc', opts.name, opts.host, opts.port);
  // noVNC connects when VncView mounts in the renderer.
  notifyRendererTab(sessionId, 'vnc', opts.name, opts.host, opts.port);

  // Dimensions not yet known — noVNC connects async in renderer.
  return {
    session_id: sessionId,
    connection_type: 'vnc',
    host: opts.host,
    port: opts.port,
    status: 'connected',
    width: 0,
    height: 0,
  };
}

