/**
 * IPC server for MCP communication.
 *
 * Port of src-tauri/src/ipc_server.rs
 *
 * Unix socket server that the conduit-mcp process connects to.
 * Accepts JSON-line requests, routes to the appropriate service, returns JSON-line responses.
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppState } from '../services/state.js';
import type { SshAuth } from '../services/ssh/client.js';
import { resolveSshAuth, resolveSshAuthSystem } from '../services/ssh/resolve-auth.js';
import type { RdpEngineConfig } from '../services/rdp/engine.js';
import type { ImageFormat } from '../services/rdp/framebuffer.js';
import { readSettings } from '../ipc/settings.js';
import { ensureFreeRdpReady } from '../services/rdp/engines/factory.js';
import { getSocketPath, isNamedPipe } from '../services/env-config.js';

// ---------- IPC Protocol Types ----------

/**
 * Must match the protocol in mcp/src/ipc-client.ts and
 * crates/conduit-mcp/src/client.rs exactly.
 */
interface IpcResponse {
  type: 'Success' | 'Error';
  payload: unknown;
}

function successResponse(payload: unknown): IpcResponse {
  return { type: 'Success', payload };
}

function errorResponse(code: string, message: string): IpcResponse {
  return { type: 'Error', payload: { code, message } };
}

// ---------- Approval Manager ----------

interface PendingApproval {
  credentialId: string;
  credentialName: string;
  purpose: string;
  resolve: (approved: boolean) => void;
}

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();

  addPending(requestId: string, approval: PendingApproval): void {
    this.pending.set(requestId, approval);
  }

  resolve(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve(approved);
    this.pending.delete(requestId);
    return true;
  }

  getPendingInfo(requestId: string): { credentialId: string; credentialName: string; purpose: string } | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    return {
      credentialId: entry.credentialId,
      credentialName: entry.credentialName,
      purpose: entry.purpose,
    };
  }
}

// Singleton approval manager (exported for use by IPC handlers in the renderer)
export const approvalManager = new ApprovalManager();

// Re-export getSocketPath for consumers that imported from this module
export { getSocketPath };

// ---------- Helpers ----------

/** Normalize null port to default for the connection type */
function defaultPort(port: number | null | undefined, connType: string): number {
  if (port != null) return port;
  switch (connType) {
    case 'ssh': return 22;
    case 'rdp': return 3389;
    case 'vnc': return 5900;
    default: return 0;
  }
}

/** Notify the renderer that a vault entry was created or modified (triggers UI refresh). */
function notifyRendererEntryChanged(): void {
  const mainWindow = AppState.getInstance().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:entry-changed');
  }
}

/**
 * Resolve an ID that may be a session ID (from active connections) to the
 * corresponding vault entry ID. Falls through to the original ID if no
 * matching MCP session is found — handles vault entry IDs transparently.
 */
function resolveEntryId(id: string, state: AppState): string {
  const session = state.mcpConnections.get(id);
  if (!session) return id;

  // Session found — look up the vault entry by host/port/type match
  if (!state.getActiveVault().isUnlocked()) return id;
  const entries = state.getActiveVault().listEntries();
  const match = entries.find(
    (e) => e.host === session.host &&
      defaultPort(e.port, e.entry_type) === defaultPort(session.port, session.connection_type) &&
      e.entry_type === session.connection_type,
  );
  return match?.id ?? id;
}

// ---------- Request handler ----------

export async function handleRequest(
  request: { type: string; payload?: Record<string, unknown> },
  state: AppState,
): Promise<IpcResponse> {
  const authState = state.authService?.getAuthState();

  // GetTierInfo is unauthenticated so the MCP server can always learn its
  // per-user quota (local-mode users have no profile but still get Free-tier
  // treatment with a daily quota enforced in the MCP server).
  if (request.type === 'GetTierInfo') {
    const profile = authState?.profile;
    const features = (profile?.tier?.features ?? {}) as Record<string, unknown>;
    const mcpDailyQuota = typeof features.mcp_daily_quota === 'number' ? features.mcp_daily_quota : 50;
    return successResponse({
      tier_name: profile?.tier?.name ?? 'free',
      mcp_daily_quota: mcpDailyQuota,
      authenticated: !!authState?.user,
    });
  }

  // Defense-in-depth: block MCP tool calls for tiers without mcp_enabled.
  // Free/Pro/Team all have mcp_enabled=true; local-mode users have no profile
  // so we allow them through here and rely on the MCP-side daily quota to cap usage.
  if (authState?.profile && !authState.profile.tier?.features?.mcp_enabled) {
    return errorResponse('TIER_RESTRICTED', 'MCP access is not available on your plan');
  }

  try {
    switch (request.type) {
      // ---- Terminal operations ----

      case 'TerminalWrite': {
        const { session_id, data } = request.payload as { session_id: string; data: number[] };
        try {
          state.terminalManager.write(session_id, new Uint8Array(data));
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('TERMINAL_ERROR', String(e));
        }
      }

      case 'TerminalReadBuffer': {
        const { session_id, lines } = request.payload as { session_id: string; lines: number };
        try {
          const content = state.terminalManager.readBuffer(session_id, lines);
          return successResponse({ content });
        } catch (e) {
          return errorResponse('TERMINAL_ERROR', String(e));
        }
      }

      case 'LocalShellCreate': {
        const { shell_type } = request.payload as { shell_type: string | null };
        try {
          const sessionId = state.terminalManager.createLocalShell(shell_type);
          state.terminalManager.startReading(sessionId);

          // Register in MCP connection registry
          state.mcpConnections.set(sessionId, {
            session_id: sessionId,
            name: `Local Shell`,
            connection_type: 'local_shell',
            host: null,
            port: null,
            status: 'connected',
            created_at: Date.now(),
          });

          // Notify renderer to create a tab for this MCP-created session
          const mainWindow = AppState.getInstance().getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('session:mcp-created', {
              sessionId,
              type: 'local_shell',
              title: 'Terminal',
            });
          }

          return successResponse({ session_id: sessionId });
        } catch (e) {
          return errorResponse('SHELL_ERROR', String(e));
        }
      }

      // ---- Credential operations ----

      case 'CredentialList': {
        if (!state.getActiveVault().isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }
        try {
          const credentials = state.getActiveVault().listCredentials();
          const list = credentials.map((c) => ({
            id: c.id,
            name: c.name,
            username: c.username,
            has_password: true,
            has_private_key: false,
            domain: c.domain,
            tags: c.tags,
            credential_type: c.credential_type ?? null,
            created_at: c.created_at,
            updated_at: c.created_at,
          }));
          return successResponse(list);
        } catch (e) {
          return errorResponse('VAULT_ERROR', String(e));
        }
      }

      case 'CredentialGet': {
        const { id } = request.payload as { id: string };
        if (!state.getActiveVault().isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }
        try {
          const cred = state.getActiveVault().getCredential(id);
          return successResponse({
            id: cred.id,
            name: cred.name,
            username: cred.username,
            password: cred.password,
            private_key: cred.private_key,
            domain: cred.domain,
            tags: cred.tags,
            credential_type: cred.credential_type ?? null,
            public_key: cred.public_key ?? null,
            fingerprint: cred.fingerprint ?? null,
            has_totp: !!cred.totp_secret,
            totp_issuer: cred.totp_issuer ?? null,
            totp_label: cred.totp_label ?? null,
            totp_algorithm: cred.totp_algorithm ?? null,
            totp_digits: cred.totp_digits ?? null,
            totp_period: cred.totp_period ?? null,
            created_at: cred.created_at,
            updated_at: cred.updated_at,
          });
        } catch (e) {
          return errorResponse('VAULT_ERROR', String(e));
        }
      }

      case 'CredentialCreate': {
        const { name, username, password, domain, private_key, totp_secret, tags, credential_type, public_key, fingerprint, totp_issuer, totp_label, totp_algorithm, totp_digits, totp_period, ssh_auth_method } = request.payload as {
          name: string;
          username: string | null;
          password: string | null;
          domain: string | null;
          private_key: string | null;
          totp_secret?: string | null;
          tags: string[];
          credential_type?: string | null;
          public_key?: string | null;
          fingerprint?: string | null;
          totp_issuer?: string | null;
          totp_label?: string | null;
          totp_algorithm?: string | null;
          totp_digits?: number | null;
          totp_period?: number | null;
          ssh_auth_method?: string | null;
        };
        if (!state.getActiveVault().isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }
        try {
          const config: Record<string, unknown> = {};
          if (public_key) config.public_key = public_key;
          if (fingerprint) config.fingerprint = fingerprint;
          if (totp_issuer) config.totp_issuer = totp_issuer;
          if (totp_label) config.totp_label = totp_label;
          if (totp_algorithm) config.totp_algorithm = totp_algorithm;
          if (totp_digits) config.totp_digits = totp_digits;
          if (totp_period) config.totp_period = totp_period;
          if (ssh_auth_method) config.ssh_auth_method = ssh_auth_method;

          const cred = state.getActiveVault().createCredential({
            name,
            username,
            password,
            domain,
            private_key,
            totp_secret,
            tags,
            credential_type: credential_type ?? null,
            config: Object.keys(config).length > 0 ? config : undefined,
          });
          return successResponse({
            id: cred.id,
            name: cred.name,
            credential_type: cred.credential_type ?? null,
            created_at: cred.created_at,
          });
        } catch (e) {
          return errorResponse('VAULT_ERROR', String(e));
        }
      }

      case 'CredentialDelete': {
        const { id } = request.payload as { id: string };
        if (!state.getActiveVault().isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }
        try {
          state.getActiveVault().deleteCredential(id);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VAULT_ERROR', String(e));
        }
      }

      case 'RequestCredentialApproval': {
        const { credential_id, purpose } = request.payload as {
          credential_id: string;
          purpose: string;
        };
        if (!state.getActiveVault().isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        // Get credential name for display
        let credentialName = credential_id;
        try {
          const cred = state.getActiveVault().getCredential(credential_id);
          credentialName = cred.name;
        } catch {
          // Use ID as fallback
        }

        // Create promise for approval response
        const requestId = randomUUID();
        const approvalPromise = new Promise<boolean>((resolve) => {
          approvalManager.addPending(requestId, {
            credentialId: credential_id,
            credentialName,
            purpose,
            resolve,
          });
        });

        // Emit event to renderer to show approval dialog
        const mainWindow = AppState.getInstance().getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mcp:approval_request', {
            request_id: requestId,
            credential_id,
            credential_name: credentialName,
            purpose,
          });
        }

        // Wait with 60s timeout
        const timeoutPromise = new Promise<boolean>((resolve) => {
          setTimeout(() => {
            approvalManager.resolve(requestId, false);
            resolve(false);
          }, 60_000);
        });

        const approved = await Promise.race([approvalPromise, timeoutPromise]);
        return successResponse({ approved });
      }

      case 'RequestToolApproval': {
        const { tool_name, args } = request.payload as {
          tool_name: string;
          args: Record<string, unknown>;
        };

        // Validate tool_name against registry — reject unknown tools
        const { TOOL_REGISTRY } = await import('../services/ai/tool-registry.js');
        const registeredTool = TOOL_REGISTRY.find((t) => t.name === tool_name);
        if (!registeredTool) {
          return errorResponse('UNKNOWN_TOOL', `Unknown tool: ${tool_name}`);
        }

        // Use canonical description/category from registry, not caller-supplied values
        const result = await state.toolApproval.requestApproval(
          registeredTool.name,
          registeredTool.description,
          registeredTool.category,
          args,
        );
        return successResponse({ approved: result.approved });
      }

      // ---- Connection operations ----

      case 'ConnectionList': {
        try {
          // Pre-fetch vault entries once for entry_id lookup
          const vaultEntries = state.getActiveVault().isUnlocked() ? state.getActiveVault().listEntries() : [];

          // Return active MCP connections (real sessions, not vault entries)
          const connections = Array.from(state.mcpConnections.values())
            .filter((c) => {
              // Verify the session still exists (type-aware check)
              if (c.connection_type === 'rdp') {
                const rdpSession = state.rdpManager.get(c.session_id);
                if (!rdpSession || !rdpSession.isConnected()) {
                  state.mcpConnections.delete(c.session_id);
                  return false;
                }
              } else if (c.connection_type === 'vnc') {
                const vncSession = state.vncManager.get(c.session_id);
                if (!vncSession || !vncSession.isConnected) {
                  state.mcpConnections.delete(c.session_id);
                  return false;
                }
              } else {
                if (!state.terminalManager.isConnected(c.session_id)) {
                  state.mcpConnections.delete(c.session_id);
                  return false;
                }
              }
              return true;
            })
            .map((c) => {
              // Resolve vault entry ID so agents can use it with entry tools
              const matchingEntry = vaultEntries.find(
                (e) => e.host === c.host &&
                  defaultPort(e.port, e.entry_type) === defaultPort(c.port, c.connection_type) &&
                  e.entry_type === c.connection_type,
              );
              return {
                id: c.session_id,
                entry_id: matchingEntry?.id ?? null,
                name: c.name,
                connection_type: c.connection_type,
                host: c.host,
                port: c.port,
                status: c.status,
              };
            });

          // Include active web sessions from WebSessionManager
          const webSessions = state.webManager.listSessions();
          for (const ws of webSessions) {
            if (ws.state === 'connected') {
              // Use the entry_id tracked at session creation, not URL matching
              const wsEntry = ws.entryId
                ? vaultEntries.find((e) => e.id === ws.entryId)
                : null;
              connections.push({
                id: ws.id,
                entry_id: wsEntry?.id ?? null,
                name: ws.title || ws.url,
                connection_type: 'web',
                host: (() => { try { return new URL(ws.url).hostname; } catch { return ws.url; } })(),
                port: (() => { try { const u = new URL(ws.url); return u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80); } catch { return null; } })(),
                status: 'connected',
              });
            }
          }

          // Also include vault entries as saved (not active) connections
          for (const e of vaultEntries) {
            if (e.entry_type === 'credential') continue;
            // Skip if already tracked as an active connection (normalize default ports)
            const entryPort = defaultPort(e.port, e.entry_type);
            const alreadyActive = connections.some(
              (c) => c.host === e.host &&
                defaultPort(c.port, c.connection_type) === entryPort &&
                c.connection_type === e.entry_type,
            );
            if (!alreadyActive) {
              connections.push({
                id: e.id,
                entry_id: e.id,
                name: e.name,
                connection_type: e.entry_type,
                host: e.host ?? null,
                port: e.port ?? null,
                status: 'disconnected',
              });
            }
          }

          return successResponse(connections);
        } catch (e) {
          return errorResponse('CONNECTION_ERROR', String(e));
        }
      }

      case 'ConnectionOpen': {
        const { connection_type, host, port, credential_id, username, password, private_key, ssh_auth_method } = request.payload as {
          connection_type: string;
          host: string;
          port: number;
          credential_id: string | null;
          username: string | null;
          password: string | null;
          private_key?: string | null;
          ssh_auth_method?: string | null;
        };

        if (connection_type === 'ssh') {
          try {
            let auth: SshAuth;

            if (credential_id) {
              // Resolve credential from vault
              if (!state.getActiveVault().isUnlocked()) {
                return errorResponse('VAULT_LOCKED', 'Vault is locked — unlock it in the Conduit app first');
              }
              const cred = state.getActiveVault().getCredential(credential_id);
              if (!cred) {
                return errorResponse('CREDENTIAL_NOT_FOUND', `Credential not found: ${credential_id}`);
              }
              auth = resolveSshAuth(cred, ssh_auth_method);
            } else if (username) {
              auth = resolveSshAuth({
                username,
                password: password || null,
                private_key: private_key || null,
              }, ssh_auth_method);
            } else {
              auth = resolveSshAuthSystem();
            }

            const sessionId = await state.terminalManager.createSshSession({
              host,
              port: port ?? 22,
              auth,
            });
            state.terminalManager.startReading(sessionId);

            // Register in MCP connection registry
            state.mcpConnections.set(sessionId, {
              session_id: sessionId,
              name: `SSH ${host}`,
              connection_type: 'ssh',
              host,
              port: port ?? 22,
              status: 'connected',
              created_at: Date.now(),
            });

            // Notify renderer to create a tab for this MCP-created session
            const mainWindow = AppState.getInstance().getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('session:mcp-created', {
                sessionId,
                type: 'ssh',
                title: `SSH ${host}`,
                host,
                port: port ?? 22,
              });
            }

            return successResponse({
              session_id: sessionId,
              connection_type: 'ssh',
              host,
              port: port ?? 22,
              status: 'connected',
            });
          } catch (e) {
            return errorResponse('SSH_ERROR', String(e));
          }
        }

        if (connection_type === 'rdp') {
          try {
            let rdpUsername = 'Administrator';
            let rdpPassword = '';
            let rdpDomain: string | undefined;

            if (credential_id) {
              if (!state.getActiveVault().isUnlocked()) {
                return errorResponse('VAULT_LOCKED', 'Vault is locked — unlock it in the Conduit app first');
              }
              const cred = state.getActiveVault().getCredential(credential_id);
              if (!cred) {
                return errorResponse('CREDENTIAL_NOT_FOUND', `Credential not found: ${credential_id}`);
              }
              rdpUsername = cred.username || 'Administrator';
              rdpPassword = cred.password || '';
              rdpDomain = cred.domain || undefined;
            } else if (username) {
              rdpUsername = username;
              rdpPassword = password || '';
            }

            const config: RdpEngineConfig = {
              host,
              port: port ?? 3389,
              username: rdpUsername,
              password: rdpPassword,
              domain: rdpDomain,
              width: 1920,
              height: 1080,
              enableNla: true,
              skipCertVerification: true,
            };

            // Ensure FreeRDP helper binary is available (auto-builds if missing)
            await ensureFreeRdpReady();

            const sessionId = randomUUID();
            const session = state.rdpManager.create(sessionId, config);

            // Set window for frame events
            const mainWindow = AppState.getInstance().getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              session.setWindow(mainWindow);
            }

            await session.connect();

            // Register in MCP connection registry
            state.mcpConnections.set(sessionId, {
              session_id: sessionId,
              name: `RDP ${host}`,
              connection_type: 'rdp',
              host,
              port: port ?? 3389,
              status: 'connected',
              created_at: Date.now(),
            });

            // Notify renderer to create a tab
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('session:mcp-created', {
                sessionId,
                type: 'rdp',
                title: `RDP ${host}`,
                host,
                port: port ?? 3389,
              });
            }

            const dims = session.getDimensions();
            return successResponse({
              session_id: sessionId,
              connection_type: 'rdp',
              host,
              port: port ?? 3389,
              status: 'connected',
              width: dims.width,
              height: dims.height,
            });
          } catch (e) {
            return errorResponse('RDP_ERROR', String(e));
          }
        }

        if (connection_type === 'vnc') {
          try {
            let vncPassword: string | undefined;
            let vncUsername: string | undefined;

            if (credential_id) {
              if (!state.getActiveVault().isUnlocked()) {
                return errorResponse('VAULT_LOCKED', 'Vault is locked — unlock it in the Conduit app first');
              }
              const cred = state.getActiveVault().getCredential(credential_id);
              if (!cred) {
                return errorResponse('CREDENTIAL_NOT_FOUND', `Credential not found: ${credential_id}`);
              }
              vncPassword = cred.password || undefined;
              vncUsername = cred.username || undefined;
            } else if (password) {
              vncPassword = password;
            }

            // Accept username from MCP request payload
            const reqUsername = (request.payload as { username?: string }).username;
            if (reqUsername) vncUsername = reqUsername;

            const sessionId = randomUUID();
            await state.vncManager.create(sessionId, {
              host,
              port: port ?? 5900,
              password: vncPassword,
              username: vncUsername,
            });
            await state.vncManager.connect(sessionId);

            // Register in MCP connection registry
            state.mcpConnections.set(sessionId, {
              session_id: sessionId,
              name: `VNC ${host}`,
              connection_type: 'vnc',
              host,
              port: port ?? 5900,
              status: 'connected',
              created_at: Date.now(),
            });

            // Notify renderer to create tab — noVNC connects when VncView mounts
            const mainWindow = AppState.getInstance().getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('session:mcp-created', {
                sessionId,
                type: 'vnc',
                title: `VNC ${host}`,
                host,
                port: port ?? 5900,
              });
            }

            // Dimensions not yet known — noVNC connects async in renderer
            return successResponse({
              session_id: sessionId,
              connection_type: 'vnc',
              host,
              port: port ?? 5900,
              status: 'connected',
              width: 0,
              height: 0,
            });
          } catch (e) {
            return errorResponse('VNC_ERROR', String(e));
          }
        }

        return errorResponse(
          'NOT_IMPLEMENTED',
          `Opening ${connection_type} connection to ${host}:${port} not yet implemented`,
        );
      }

      case 'ConnectionClose': {
        const { id } = request.payload as { id: string };
        try {
          const conn = state.mcpConnections.get(id);
          if (conn && conn.connection_type === 'rdp') {
            await state.rdpManager.remove(id);
          } else if (conn && conn.connection_type === 'vnc') {
            state.vncManager.disconnect(id);
          } else {
            state.terminalManager.close(id);
          }
          state.mcpConnections.delete(id);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('CLOSE_ERROR', String(e));
        }
      }

      // ---- Web operations ----

      case 'WebSessionCreate': {
        const { url, user_agent, engine } = request.payload as { url: string; user_agent: string | null; engine?: string };
        try {
          const sessionId = state.webManager.createSession(url, user_agent ?? undefined, undefined, undefined, engine as 'auto' | 'chromium' | 'webview2' | undefined);
          // Create webview with default bounds — the renderer will reposition
          await state.webManager.createWebview(sessionId, 250, 40, 800, 600);
          return successResponse({ session_id: sessionId });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionClose': {
        const { session_id } = request.payload as { session_id: string };
        try {
          state.webManager.closeSession(session_id);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('NOT_FOUND', String(e));
        }
      }

      case 'WebSessionNavigate': {
        const { session_id, url } = request.payload as { session_id: string; url: string };
        try {
          state.webManager.navigate(session_id, url);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGetUrl': {
        const { session_id } = request.payload as { session_id: string };
        try {
          const url = state.webManager.getUrl(session_id);
          return successResponse({ url });
        } catch (e) {
          return errorResponse('NOT_FOUND', String(e));
        }
      }

      case 'WebSessionGetTitle': {
        const { session_id } = request.payload as { session_id: string };
        try {
          const title = state.webManager.getTitle(session_id);
          return successResponse({ title: title ?? '' });
        } catch (e) {
          return errorResponse('NOT_FOUND', String(e));
        }
      }

      case 'WebSessionScreenshot': {
        const { session_id, format, quality, max_width } = request.payload as {
          session_id: string;
          full_page: boolean;
          format: string | null;
          quality: number | null;
          max_width: number | null;
        };
        try {
          const result = await state.webManager.screenshot(
            session_id,
            (format || 'png') as 'png' | 'jpeg',
            quality ?? 85,
            max_width ?? undefined,
          );
          return successResponse({
            image: result.image,
            image_width: result.imageWidth,
            image_height: result.imageHeight,
          });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionReadContent': {
        const { session_id, selector, format } = request.payload as {
          session_id: string;
          selector: string | null;
          format: string;
        };
        try {
          const content = await state.webManager.readContent(
            session_id,
            selector ?? undefined,
            format,
          );
          return successResponse({ content });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionClick': {
        const { session_id, x, y, button, double_click } = request.payload as {
          session_id: string; x: number; y: number; button: string; double_click: boolean;
        };
        try {
          state.webManager.click(session_id, x, y, (button || 'left') as 'left' | 'right' | 'middle', double_click ?? false);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionType': {
        const { session_id, text } = request.payload as { session_id: string; text: string };
        try {
          await state.webManager.typeText(session_id, text);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionSendKey': {
        const { session_id, key, modifiers, action } = request.payload as {
          session_id: string; key: string; modifiers: string[]; action: string;
        };
        try {
          state.webManager.sendKey(session_id, key, modifiers ?? [], (action || 'press') as 'press' | 'down' | 'up');
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionMouseMove': {
        const { session_id, x, y } = request.payload as { session_id: string; x: number; y: number };
        try {
          state.webManager.mouseMove(session_id, x, y);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionMouseDrag': {
        const { session_id, from_x, from_y, to_x, to_y, button } = request.payload as {
          session_id: string; from_x: number; from_y: number; to_x: number; to_y: number; button: string;
        };
        try {
          state.webManager.mouseDrag(session_id, from_x, from_y, to_x, to_y, (button || 'left') as 'left' | 'right' | 'middle');
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionMouseScroll': {
        const { session_id, x, y, delta_x, delta_y } = request.payload as {
          session_id: string; x: number; y: number; delta_x: number; delta_y: number;
        };
        try {
          state.webManager.mouseScroll(session_id, x, y, delta_x ?? 0, delta_y ?? 0);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGetDimensions': {
        const { session_id } = request.payload as { session_id: string };
        try {
          const dims = state.webManager.getViewportDimensions(session_id);
          return successResponse({ width: dims.width, height: dims.height });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionClickElement': {
        const { session_id, selector } = request.payload as { session_id: string; selector: string };
        try {
          const clicked = await state.webManager.clickElement(session_id, selector);
          return successResponse({ success: true, clicked });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionFillInput': {
        const { session_id, selector, value } = request.payload as {
          session_id: string; selector: string; value: string;
        };
        try {
          const filled = await state.webManager.fillInput(session_id, selector, value);
          return successResponse({ success: true, filled });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGetElements': {
        const { session_id } = request.payload as { session_id: string };
        try {
          const elements = await state.webManager.getInteractiveElements(session_id);
          return successResponse({ elements });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionExecuteJs': {
        const { session_id, code } = request.payload as { session_id: string; code: string };
        try {
          const result = await state.webManager.executeJs(session_id, code);
          return successResponse({ result: result !== undefined ? result : null });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionCreateTab': {
        const { session_id, url } = request.payload as { session_id: string; url?: string };
        try {
          const tabId = state.webManager.createTab(session_id, url);
          return successResponse({ tab_id: tabId });
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionCloseTab': {
        const { session_id, tab_id } = request.payload as { session_id: string; tab_id: string };
        try {
          const result = state.webManager.closeTab(session_id, tab_id);
          return successResponse(result);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionSwitchTab': {
        const { session_id, tab_id } = request.payload as { session_id: string; tab_id: string };
        try {
          state.webManager.switchTab(session_id, tab_id);
          return successResponse(null);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGoBack': {
        const { session_id } = request.payload as { session_id: string };
        try {
          state.webManager.goBack(session_id);
          return successResponse(null);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGoForward': {
        const { session_id } = request.payload as { session_id: string };
        try {
          state.webManager.goForward(session_id);
          return successResponse(null);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionReload': {
        const { session_id } = request.payload as { session_id: string };
        try {
          state.webManager.reload(session_id);
          return successResponse(null);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      case 'WebSessionGetTabs': {
        const { session_id } = request.payload as { session_id: string };
        try {
          const result = state.webManager.getTabList(session_id);
          return successResponse(result);
        } catch (e) {
          return errorResponse('WEB_ERROR', String(e));
        }
      }

      // ---- RDP operations ----

      case 'RdpScreenshot': {
        const { connection_id, format, quality, region, max_width } = request.payload as {
          connection_id: string;
          format: string;
          quality: number;
          region: [number, number, number, number] | null;
          max_width: number | null;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          const fmt: ImageFormat = format === 'jpeg'
            ? { type: 'jpeg', quality: quality ?? 85 }
            : { type: 'png' };

          const mw = max_width ?? undefined;
          let result: { buffer: Buffer; width: number; height: number };
          if (region) {
            result = await session.screenshotRegion(region[0], region[1], region[2], region[3], fmt, mw);
          } else {
            result = await session.screenshot(fmt, mw);
          }
          return successResponse({
            image: result.buffer.toString('base64'),
            image_width: result.width,
            image_height: result.height,
          });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpClick': {
        const { connection_id, x, y, button, double_click } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
          button: string;
          double_click: boolean;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          const btn = (button || 'left') as 'left' | 'right' | 'middle';
          if (double_click) {
            session.mouseDoubleClick(x, y, btn);
          } else {
            session.mouseClick(x, y, btn);
          }
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpType': {
        const { connection_id, text, delay_ms } = request.payload as {
          connection_id: string;
          text: string;
          delay_ms: number;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          await session.typeText(text, delay_ms ?? 20);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpSendKey': {
        const { connection_id, key, modifiers, action } = request.payload as {
          connection_id: string;
          key: string;
          modifiers: string[];
          action: string;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          const act = action || 'press';
          if (act === 'down') {
            const code = keyNameToDomCode(key);
            session.keyDown(key, code, modifiers || []);
          } else if (act === 'up') {
            const code = keyNameToDomCode(key);
            session.keyUp(key, code);
          } else {
            // "press" — full press+release with modifiers
            session.sendKey(key, modifiers || []);
          }
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpMouseMove': {
        const { connection_id, x, y } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          session.mouseMove(x, y);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpMouseDrag': {
        const { connection_id, from_x, from_y, to_x, to_y, button } = request.payload as {
          connection_id: string;
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          button: string;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          const btn = (button || 'left') as 'left' | 'right' | 'middle';
          session.mouseDrag(from_x, from_y, to_x, to_y, btn);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpGetDimensions': {
        const { connection_id } = request.payload as { connection_id: string };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          const dims = session.getDimensions();
          return successResponse({ width: dims.width, height: dims.height });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpMouseScroll': {
        const { connection_id, x, y, delta, vertical } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
          delta: number;
          vertical: boolean;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          session.mouseScroll(x, y, delta, vertical ?? true);
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      case 'RdpResize': {
        const { connection_id, width, height } = request.payload as {
          connection_id: string;
          width: number;
          height: number;
        };
        try {
          const session = state.rdpManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `RDP session not found: ${connection_id}`);
          if (!session.isConnected()) return errorResponse('NOT_CONNECTED', 'RDP session not connected');

          await session.resize(width, height);
          const dims = session.getDimensions();
          return successResponse({ width: dims.width, height: dims.height });
        } catch (e) {
          return errorResponse('RDP_ERROR', String(e));
        }
      }

      // ---- VNC operations (relay to renderer via MCP request/response) ----

      case 'VncScreenshot': {
        const { connection_id, format, quality } = request.payload as {
          connection_id: string;
          format: string;
          quality: number;
          max_width: number | null;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          const image = await state.vncManager.sendMcpRequest(connection_id, 'screenshot', {
            format: format || 'png',
            quality: quality ?? 85,
          });
          return successResponse({ image });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncClick': {
        const { connection_id, x, y, button, double_click } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
          button: string;
          double_click: boolean;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          await state.vncManager.sendMcpRequest(connection_id, 'click', {
            x, y, button: button || 'left',
          });
          if (double_click) {
            await state.vncManager.sendMcpRequest(connection_id, 'click', {
              x, y, button: button || 'left',
            });
          }
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncType': {
        const { connection_id, text } = request.payload as {
          connection_id: string;
          text: string;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          await state.vncManager.sendMcpRequest(connection_id, 'type', { text });
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncSendKey': {
        const { connection_id, key, modifiers, action } = request.payload as {
          connection_id: string;
          key: string;
          modifiers: string[];
          action: string;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          const modObj: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {};
          for (const m of (modifiers || [])) {
            const ml = m.toLowerCase();
            if (ml === 'ctrl' || ml === 'control') modObj.ctrl = true;
            else if (ml === 'alt') modObj.alt = true;
            else if (ml === 'shift') modObj.shift = true;
            else if (ml === 'meta' || ml === 'win' || ml === 'super') modObj.meta = true;
          }

          await state.vncManager.sendMcpRequest(connection_id, 'sendKey', {
            key,
            modifiers: modObj,
            action: action || 'press',
          });
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncMouseMove': {
        const { connection_id, x, y } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          await state.vncManager.sendMcpRequest(connection_id, 'mouseMove', { x, y });
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncGetDimensions': {
        const { connection_id } = request.payload as { connection_id: string };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);

          // Try cached dimensions first, then relay to renderer
          const dims = session.getDimensions();
          if (dims.width > 0 && dims.height > 0) {
            return successResponse({ width: dims.width, height: dims.height });
          }
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          const result = await state.vncManager.sendMcpRequest(connection_id, 'getDimensions', {}) as { width: number; height: number };
          return successResponse({ width: result.width, height: result.height });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncMouseScroll': {
        const { connection_id, x, y, delta, vertical } = request.payload as {
          connection_id: string;
          x: number;
          y: number;
          delta: number;
          vertical: boolean;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          await state.vncManager.sendMcpRequest(connection_id, 'mouseScroll', {
            x, y, deltaY: delta, vertical: vertical ?? true,
          });
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      case 'VncMouseDrag': {
        const { connection_id, from_x, from_y, to_x, to_y, button } = request.payload as {
          connection_id: string;
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          button: string;
        };
        try {
          const session = state.vncManager.get(connection_id);
          if (!session) return errorResponse('NOT_FOUND', `VNC session not found: ${connection_id}`);
          if (!session.isConnected) return errorResponse('NOT_CONNECTED', 'VNC session not connected');

          await state.vncManager.sendMcpRequest(connection_id, 'mouseDrag', {
            from_x, from_y, to_x, to_y, button: button || 'left',
          });
          return successResponse({ success: true });
        } catch (e) {
          return errorResponse('VNC_ERROR', String(e));
        }
      }

      // ---- Command operations ----

      case 'CommandExecute': {
        const { entry_id, timeout_ms } = request.payload as { entry_id: string; timeout_ms: number };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const entry = vault.getEntry(entry_id);
          if (!entry) {
            return errorResponse('NOT_FOUND', 'Entry not found');
          }
          if (entry.entry_type !== 'command') {
            return errorResponse('INVALID_TYPE', 'Entry is not a command type');
          }

          const config = (entry.config ?? {}) as {
            command: string;
            args?: string;
            workingDir?: string;
            shell?: string;
            timeout?: number;
            runAsMode: 'credential' | 'current';
            guiApp?: boolean;
          };

          if (!config.command) {
            return errorResponse('INVALID_CONFIG', 'No command configured');
          }

          let credential: { username: string; password: string; domain?: string } | undefined;
          if (config.runAsMode === 'credential') {
            const cred = vault.resolveCredential(entry_id);
            if (cred?.username && cred?.password) {
              credential = {
                username: cred.username,
                password: cred.password,
                domain: cred.domain ?? undefined,
              };
            } else {
              return errorResponse('CREDENTIAL_MISSING', 'No credential configured for run-as-user mode');
            }
          }

          const sessionId = `mcp-cmd-${randomUUID()}`;
          const session = state.commandExecutor.execute(sessionId, config, credential);

          // Wait for completion with timeout
          const result = await new Promise<{ output: string; exit_code: number | null; timed_out: boolean }>((resolve, reject) => {
            const timer = setTimeout(() => {
              session.cancel();
              resolve({
                output: session.getOutput(),
                exit_code: null,
                timed_out: true,
              });
            }, timeout_ms || 300000);

            session.on('exit', (code: number) => {
              clearTimeout(timer);
              resolve({
                output: session.getOutput(),
                exit_code: code,
                timed_out: session.status === 'timeout',
              });
            });

            session.on('error', (err: string) => {
              clearTimeout(timer);
              reject(new Error(err));
            });

            // If already exited (e.g., GUI app), resolve immediately
            if (!session.isRunning) {
              clearTimeout(timer);
              resolve({
                output: session.getOutput(),
                exit_code: session.exitCode,
                timed_out: false,
              });
            }
          });

          // Cleanup
          state.commandExecutor.close(sessionId);

          return successResponse(result);
        } catch (e) {
          return errorResponse('COMMAND_ERROR', String(e));
        }
      }

      // ---- Entry operations ----

      case 'EntryGetInfo': {
        const { id, include_notes } = request.payload as { id: string; include_notes?: boolean };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const resolvedId = resolveEntryId(id, state);
          const entry = vault.getEntryMeta(resolvedId);
          const result: Record<string, unknown> = {
            id: entry.id,
            name: entry.name,
            entry_type: entry.entry_type,
            host: entry.host ?? null,
            port: entry.port ?? null,
            tags: entry.tags ?? [],
            folder_id: entry.folder_id ?? null,
            is_favorite: entry.is_favorite ?? false,
            credential_id: entry.credential_id ?? null,
            username: entry.username ?? null,
            domain: entry.domain ?? null,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
          };
          // Only include notes when explicitly requested — and redact !!secret!! values
          if (include_notes) {
            const raw = entry.notes ?? '';
            result.notes = raw.replace(/!!secret!![^!]*!!secret!!/g, '********');
          }
          return successResponse(result);
        } catch (e) {
          return errorResponse('ENTRY_ERROR', String(e));
        }
      }

      case 'EntryGetDocument': {
        const { id } = request.payload as { id: string };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const resolvedId = resolveEntryId(id, state);
          const entry = vault.getEntryMeta(resolvedId);
          if (entry.entry_type !== 'document') {
            return errorResponse('INVALID_TYPE', 'Entry is not a document type');
          }

          const config = (entry.config ?? {}) as { content?: string };
          return successResponse({
            id: entry.id,
            name: entry.name,
            content: config.content ?? null,
            tags: entry.tags ?? [],
            created_at: entry.created_at,
            updated_at: entry.updated_at,
          });
        } catch (e) {
          return errorResponse('ENTRY_ERROR', String(e));
        }
      }

      case 'EntryUpdateNotes': {
        const { id, notes } = request.payload as { id: string; notes: string };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const resolvedId = resolveEntryId(id, state);
          const updated = vault.updateEntry(resolvedId, { notes });
          notifyRendererEntryChanged();
          return successResponse({
            id: updated.id,
            name: updated.name,
            updated_at: updated.updated_at,
          });
        } catch (e) {
          return errorResponse('ENTRY_ERROR', String(e));
        }
      }

      case 'DocumentCreate': {
        const { name, content, folder_id, tags } = request.payload as {
          name: string;
          content: string;
          folder_id: string | null;
          tags: string[];
        };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const entry = vault.createEntry({
            name,
            entry_type: 'document',
            folder_id: folder_id ?? undefined,
            config: { content },
            tags,
          });
          notifyRendererEntryChanged();
          return successResponse({
            id: entry.id,
            name: entry.name,
            created_at: entry.created_at,
          });
        } catch (e) {
          return errorResponse('ENTRY_ERROR', String(e));
        }
      }

      case 'DocumentUpdate': {
        const { id, content, name: newName } = request.payload as {
          id: string;
          content: string;
          name: string | null;
        };
        const vault = state.getActiveVault();
        if (!vault.isUnlocked()) {
          return errorResponse('VAULT_LOCKED', 'Vault is locked');
        }

        try {
          const resolvedId = resolveEntryId(id, state);
          const existing = vault.getEntryMeta(resolvedId);
          if (existing.entry_type !== 'document') {
            return errorResponse('INVALID_TYPE', 'Entry is not a document type');
          }

          const existingConfig = (existing.config ?? {}) as Record<string, unknown>;
          const updatedConfig = { ...existingConfig, content };
          const updateInput: Record<string, unknown> = { config: updatedConfig };
          if (newName) {
            updateInput.name = newName;
          }

          const updated = vault.updateEntry(resolvedId, updateInput);
          notifyRendererEntryChanged();
          return successResponse({
            id: updated.id,
            name: updated.name,
            updated_at: updated.updated_at,
          });
        } catch (e) {
          return errorResponse('ENTRY_ERROR', String(e));
        }
      }

      default:
        return errorResponse('UNKNOWN_REQUEST', `Unknown request type: ${request.type}`);
    }
  } catch (e) {
    return errorResponse('INTERNAL_ERROR', `Unexpected error: ${e}`);
  }
}

// ---------- Key name to DOM code mapping ----------

/**
 * Map MCP key names (e.g., "Enter", "a", "F1") to DOM KeyboardEvent.code strings
 * (e.g., "Enter", "KeyA", "F1") for use with RDP/VNC keyDown/keyUp.
 */
function keyNameToDomCode(key: string): string {
  // Single characters map to Key{Upper} or Digit{N}
  if (key.length === 1) {
    const c = key;
    if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
    if (c >= 'A' && c <= 'Z') return `Key${c}`;
    if (c >= '0' && c <= '9') return `Digit${c}`;
    // Punctuation — best-effort map
    const PUNCT: Record<string, string> = {
      '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
      '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
      ',': 'Comma', '.': 'Period', '/': 'Slash', ' ': 'Space',
    };
    return PUNCT[c] || 'Space';
  }

  // Named keys — map to DOM code strings
  const NAMED: Record<string, string> = {
    'Enter': 'Enter', 'Return': 'Enter',
    'Backspace': 'Backspace', 'Tab': 'Tab',
    'Escape': 'Escape', 'Esc': 'Escape',
    'Space': 'Space',
    'Delete': 'Delete', 'Insert': 'Insert',
    'Home': 'Home', 'End': 'End',
    'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'Left': 'ArrowLeft', 'Right': 'ArrowRight',
    'Up': 'ArrowUp', 'Down': 'ArrowDown',
    'CapsLock': 'CapsLock', 'NumLock': 'NumLock', 'ScrollLock': 'ScrollLock',
    'PrintScreen': 'PrintScreen', 'Pause': 'Pause',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
    'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
    'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
    'Control': 'ControlLeft', 'Ctrl': 'ControlLeft',
    'Alt': 'AltLeft', 'Shift': 'ShiftLeft',
    'Meta': 'MetaLeft', 'Win': 'MetaLeft', 'Super': 'MetaLeft',
  };
  return NAMED[key] || key;
}

// ---------- Client handler ----------

function handleClient(socket: net.Socket, state: AppState): void {
  let data = '';

  socket.on('data', (chunk) => {
    data += chunk.toString();
    const newlineIdx = data.indexOf('\n');
    if (newlineIdx === -1) return;

    const line = data.slice(0, newlineIdx);
    data = data.slice(newlineIdx + 1);

    let request: { type: string; payload?: Record<string, unknown> };
    try {
      request = JSON.parse(line);
    } catch (e) {
      const response = errorResponse('PARSE_ERROR', String(e));
      socket.write(JSON.stringify(response) + '\n');
      socket.end();
      return;
    }

    const start = Date.now();
    console.log(`[ipc-server] Request: ${request.type}`);

    handleRequest(request, state)
      .then((response) => {
        const durationMs = Date.now() - start;
        if (response.type === 'Error') {
          const err = response.payload as { code: string; message: string };
          console.error(`[ipc-server] ${request.type} ERROR (${durationMs}ms): [${err.code}] ${err.message}`);
        } else {
          console.log(`[ipc-server] ${request.type} OK (${durationMs}ms)`);
        }
        socket.write(JSON.stringify(response) + '\n');
        socket.end();
      })
      .catch((e) => {
        const durationMs = Date.now() - start;
        console.error(`[ipc-server] ${request.type} UNHANDLED ERROR (${durationMs}ms):`, e);
        const response = errorResponse('HANDLER_ERROR', String(e));
        socket.write(JSON.stringify(response) + '\n');
        socket.end();
      });
  });

  socket.on('error', (err) => {
    console.error('[ipc-server] Client socket error:', err.message);
  });
}

// ---------- Start server ----------

let serverInstance: net.Server | null = null;

export async function startIpcServer(): Promise<void> {
  const socketPath = getSocketPath();
  const isPipe = isNamedPipe(socketPath);

  if (!isPipe) {
    // Unix sockets: ensure parent directory exists and clean up stale socket
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true });

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  }

  const state = AppState.getInstance();

  return new Promise<void>((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleClient(socket, state);
    });

    server.on('error', (err) => {
      console.error('[ipc-server] Server error:', err);
      reject(err);
    });

    server.listen(socketPath, () => {
      if (!isPipe) {
        // Set permissions to owner-only (0o600) — only applies to Unix sockets
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          // Ignore on platforms that don't support chmod
        }
      }
      console.log(`[ipc-server] Listening on ${socketPath}`);
      serverInstance = server;
      resolve();
    });
  });
}

export function stopIpcServer(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}
