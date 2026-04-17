/**
 * IPC client for communicating with the main Conduit Electron app.
 *
 * Port of crates/conduit-mcp/src/client.rs
 *
 * Connects via Unix socket, sends JSON-line requests, reads JSON-line responses.
 */

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ---------- IPC Protocol Types ----------

export type IpcRequest =
  | { type: 'TerminalWrite'; payload: { session_id: string; data: number[] } }
  | { type: 'TerminalReadBuffer'; payload: { session_id: string; lines: number } }
  | { type: 'LocalShellCreate'; payload: { shell_type: string | null } }
  | { type: 'CredentialList'; payload: Record<string, never> }
  | { type: 'CredentialGet'; payload: { id: string } }
  | { type: 'CredentialCreate'; payload: { name: string; username: string | null; password: string | null; domain: string | null; private_key: string | null; tags: string[]; credential_type?: string | null; public_key?: string | null; fingerprint?: string | null; totp_secret?: string | null; totp_issuer?: string | null; totp_label?: string | null } }
  | { type: 'CredentialDelete'; payload: { id: string } }
  | { type: 'RequestCredentialApproval'; payload: { credential_id: string; purpose: string } }
  | { type: 'ConnectionList'; payload: Record<string, never> }
  | { type: 'ConnectionOpen'; payload: { connection_type: string; host: string; port: number; credential_id: string | null; username: string | null; password: string | null; ssh_auth_method?: string | null } }
  | { type: 'ConnectionClose'; payload: { id: string } }
  | { type: 'RdpScreenshot'; payload: { connection_id: string; format: string; quality: number; region: [number, number, number, number] | null; max_width: number | null } }
  | { type: 'RdpClick'; payload: { connection_id: string; x: number; y: number; button: string; double_click: boolean } }
  | { type: 'RdpType'; payload: { connection_id: string; text: string; delay_ms: number } }
  | { type: 'RdpSendKey'; payload: { connection_id: string; key: string; modifiers: string[]; action: string } }
  | { type: 'RdpMouseMove'; payload: { connection_id: string; x: number; y: number } }
  | { type: 'RdpMouseDrag'; payload: { connection_id: string; from_x: number; from_y: number; to_x: number; to_y: number; button: string } }
  | { type: 'RdpGetDimensions'; payload: { connection_id: string } }
  | { type: 'RdpMouseScroll'; payload: { connection_id: string; x: number; y: number; delta: number; vertical: boolean } }
  | { type: 'RdpResize'; payload: { connection_id: string; width: number; height: number } }
  | { type: 'VncScreenshot'; payload: { connection_id: string; format: string; quality: number; max_width: number | null } }
  | { type: 'VncClick'; payload: { connection_id: string; x: number; y: number; button: string; double_click: boolean } }
  | { type: 'VncType'; payload: { connection_id: string; text: string } }
  | { type: 'VncSendKey'; payload: { connection_id: string; key: string; modifiers: string[]; action: string } }
  | { type: 'VncMouseMove'; payload: { connection_id: string; x: number; y: number } }
  | { type: 'VncGetDimensions'; payload: { connection_id: string } }
  | { type: 'VncMouseScroll'; payload: { connection_id: string; x: number; y: number; delta: number; vertical: boolean } }
  | { type: 'VncMouseDrag'; payload: { connection_id: string; from_x: number; from_y: number; to_x: number; to_y: number; button: string } }
  | { type: 'WebSessionCreate'; payload: { url: string; user_agent: string | null } }
  | { type: 'WebSessionClose'; payload: { session_id: string } }
  | { type: 'WebSessionNavigate'; payload: { session_id: string; url: string } }
  | { type: 'WebSessionGetUrl'; payload: { session_id: string } }
  | { type: 'WebSessionGetTitle'; payload: { session_id: string } }
  | { type: 'WebSessionScreenshot'; payload: { session_id: string; full_page: boolean; format: string | null; quality: number | null; max_width: number | null } }
  | { type: 'WebSessionReadContent'; payload: { session_id: string; selector: string | null; format: string } }
  | { type: 'WebSessionClick'; payload: { session_id: string; x: number; y: number; button: string; double_click: boolean } }
  | { type: 'WebSessionType'; payload: { session_id: string; text: string } }
  | { type: 'WebSessionSendKey'; payload: { session_id: string; key: string; modifiers: string[]; action: string } }
  | { type: 'WebSessionMouseMove'; payload: { session_id: string; x: number; y: number } }
  | { type: 'WebSessionMouseDrag'; payload: { session_id: string; from_x: number; from_y: number; to_x: number; to_y: number; button: string } }
  | { type: 'WebSessionMouseScroll'; payload: { session_id: string; x: number; y: number; delta_x: number; delta_y: number } }
  | { type: 'WebSessionGetDimensions'; payload: { session_id: string } }
  | { type: 'WebSessionClickElement'; payload: { session_id: string; selector: string } }
  | { type: 'WebSessionFillInput'; payload: { session_id: string; selector: string; value: string } }
  | { type: 'WebSessionGetElements'; payload: { session_id: string } }
  | { type: 'WebSessionExecuteJs'; payload: { session_id: string; code: string } }
  | { type: 'WebSessionCreateTab'; payload: { session_id: string; url?: string } }
  | { type: 'WebSessionCloseTab'; payload: { session_id: string; tab_id: string } }
  | { type: 'WebSessionSwitchTab'; payload: { session_id: string; tab_id: string } }
  | { type: 'WebSessionGetTabs'; payload: { session_id: string } }
  | { type: 'WebSessionGoBack'; payload: { session_id: string } }
  | { type: 'WebSessionGoForward'; payload: { session_id: string } }
  | { type: 'WebSessionReload'; payload: { session_id: string } }
  | { type: 'CommandExecute'; payload: { entry_id: string; timeout_ms: number } }
  | { type: 'EntryGetInfo'; payload: { id: string; include_notes: boolean } }
  | { type: 'EntryGetDocument'; payload: { id: string } }
  | { type: 'EntryUpdateNotes'; payload: { id: string; notes: string } }
  | { type: 'DocumentCreate'; payload: { name: string; content: string; folder_id: string | null; tags: string[] } }
  | { type: 'DocumentUpdate'; payload: { id: string; content: string; name: string | null } }
  | { type: 'RequestToolApproval'; payload: { tool_name: string; description: string; category: string; args: Record<string, unknown> } }
  | { type: 'GetTierInfo'; payload: Record<string, never> };

export interface TierInfo {
  tier_name: string;
  mcp_daily_quota: number; // -1 = unlimited
  authenticated: boolean;
}

export type IpcResponse =
  | { type: 'Success'; payload: Record<string, unknown> }
  | { type: 'Error'; payload: { code: string; message: string } };

// ---------- Socket path resolution ----------

function getSocketPath(): string {
  // Allow explicit override (e.g. when Electron passes the resolved path)
  if (process.env.CONDUIT_SOCKET_PATH) {
    return process.env.CONDUIT_SOCKET_PATH;
  }

  // Derive directory name from environment (matches env-config.ts in main process)
  const dirName = process.env.CONDUIT_ENV === 'preview' ? 'conduit-dev' : 'conduit';

  // Windows: use named pipes (not filesystem sockets)
  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\${dirName}`;
  }

  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime) {
    return path.join(xdgRuntime, dirName, 'conduit.sock');
  }

  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', dirName, 'conduit.sock');
  }

  if (platform === 'linux') {
    return path.join(home, '.local', 'share', dirName, 'conduit.sock');
  }

  return path.join('/tmp', dirName, 'conduit.sock');
}

// ---------- IPC Client ----------

export class ConduitClient {
  private socketPath: string;

  private constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  static async connect(): Promise<ConduitClient> {
    const socketPath = getSocketPath();
    // Named pipes (Windows) aren't filesystem entries — skip existsSync check
    const isNamedPipe = socketPath.startsWith('\\\\.\\pipe\\');
    if (!isNamedPipe && !fs.existsSync(socketPath)) {
      throw new Error('Conduit app is not running (socket not found)');
    }
    return new ConduitClient(socketPath);
  }

  private sendRequest(request: IpcRequest): Promise<Record<string, unknown>> {
    return this.sendRequestWithTimeout(request, 30_000);
  }

  private sendRequestWithTimeout(request: IpcRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let responseData = '';

      socket.on('connect', () => {
        const requestJson = JSON.stringify(request) + '\n';
        socket.write(requestJson);
      });

      socket.on('data', (chunk) => {
        responseData += chunk.toString();
        const newlineIdx = responseData.indexOf('\n');
        if (newlineIdx !== -1) {
          const line = responseData.slice(0, newlineIdx);
          socket.end();
          try {
            const response: IpcResponse = JSON.parse(line);
            if (response.type === 'Success') {
              resolve(response.payload);
            } else {
              reject(new Error(`${response.payload.code}: ${response.payload.message}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse IPC response: ${e}`));
          }
        }
      });

      socket.on('error', (err) => {
        reject(new Error(`IPC connection error: ${err.message}`));
      });

      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  // ---------- Terminal operations ----------

  async terminalWrite(sessionId: string, data: Buffer | number[]): Promise<void> {
    const dataArray = Array.isArray(data) ? data : Array.from(data);
    await this.sendRequest({
      type: 'TerminalWrite',
      payload: { session_id: sessionId, data: dataArray },
    });
  }

  async terminalReadBuffer(sessionId: string, lines: number): Promise<string> {
    const response = await this.sendRequest({
      type: 'TerminalReadBuffer',
      payload: { session_id: sessionId, lines },
    });
    return (response.content as string) ?? '';
  }

  async localShellCreate(shellType: string | null): Promise<string> {
    const response = await this.sendRequest({
      type: 'LocalShellCreate',
      payload: { shell_type: shellType },
    });
    return response.session_id as string;
  }

  // ---------- Credential operations ----------

  async credentialList(): Promise<Record<string, unknown>[]> {
    const response = await this.sendRequest({
      type: 'CredentialList',
      payload: {},
    });
    // Response is the array directly
    return response as unknown as Record<string, unknown>[];
  }

  async credentialGet(id: string): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'CredentialGet',
      payload: { id },
    });
  }

  async credentialCreate(
    name: string,
    username: string | null,
    password: string | null,
    domain: string | null,
    privateKey: string | null,
    tags: string[],
    credentialType: string | null = null,
    publicKey: string | null = null,
    fingerprint: string | null = null,
    totpSecret: string | null = null,
    totpIssuer: string | null = null,
    totpLabel: string | null = null,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'CredentialCreate',
      payload: {
        name,
        username,
        password,
        domain,
        private_key: privateKey,
        tags,
        credential_type: credentialType,
        public_key: publicKey,
        fingerprint,
        totp_secret: totpSecret,
        totp_issuer: totpIssuer,
        totp_label: totpLabel,
      },
    });
  }

  async credentialDelete(id: string): Promise<void> {
    await this.sendRequest({
      type: 'CredentialDelete',
      payload: { id },
    });
  }

  async requestCredentialApproval(credentialId: string, purpose: string): Promise<boolean> {
    const response = await this.sendRequest({
      type: 'RequestCredentialApproval',
      payload: { credential_id: credentialId, purpose },
    });
    return response.approved as boolean;
  }

  async requestToolApproval(
    toolName: string,
    description: string,
    category: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const response = await this.sendRequestWithTimeout({
      type: 'RequestToolApproval',
      payload: { tool_name: toolName, description, category, args },
    }, 130_000); // 130s > service-side 120s timeout
    return response.approved as boolean;
  }

  // ---------- Tier info ----------

  async getTierInfo(): Promise<TierInfo> {
    const response = await this.sendRequest({
      type: 'GetTierInfo',
      payload: {},
    });
    return {
      tier_name: (response.tier_name as string) ?? 'free',
      mcp_daily_quota: typeof response.mcp_daily_quota === 'number' ? response.mcp_daily_quota : 50,
      authenticated: !!response.authenticated,
    };
  }

  // ---------- Connection operations ----------

  async connectionList(): Promise<Record<string, unknown>[]> {
    const response = await this.sendRequest({
      type: 'ConnectionList',
      payload: {},
    });
    return response as unknown as Record<string, unknown>[];
  }

  async connectionOpen(
    connectionType: string,
    host: string,
    port: number,
    credentialId: string | null,
    username: string | null = null,
    password: string | null = null,
    sshAuthMethod: string | null = null,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'ConnectionOpen',
      payload: { connection_type: connectionType, host, port, credential_id: credentialId, username, password, ssh_auth_method: sshAuthMethod },
    });
  }

  async connectionClose(id: string): Promise<void> {
    await this.sendRequest({
      type: 'ConnectionClose',
      payload: { id },
    });
  }

  // ---------- RDP operations ----------

  async rdpScreenshot(
    connectionId: string,
    format: string,
    quality: number,
    region: [number, number, number, number] | null,
    maxWidth: number | null = null,
  ): Promise<{ image: string; imageWidth: number; imageHeight: number }> {
    const response = await this.sendRequest({
      type: 'RdpScreenshot',
      payload: { connection_id: connectionId, format, quality, region, max_width: maxWidth },
    });
    return {
      image: response.image as string,
      imageWidth: response.image_width as number,
      imageHeight: response.image_height as number,
    };
  }

  async rdpClick(
    connectionId: string,
    x: number,
    y: number,
    button: string,
    doubleClick: boolean,
  ): Promise<void> {
    await this.sendRequest({
      type: 'RdpClick',
      payload: { connection_id: connectionId, x, y, button, double_click: doubleClick },
    });
  }

  async rdpType(connectionId: string, text: string, delayMs: number): Promise<void> {
    await this.sendRequest({
      type: 'RdpType',
      payload: { connection_id: connectionId, text, delay_ms: delayMs },
    });
  }

  async rdpSendKey(
    connectionId: string,
    key: string,
    modifiers: string[],
    action: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'RdpSendKey',
      payload: { connection_id: connectionId, key, modifiers, action },
    });
  }

  async rdpMouseMove(connectionId: string, x: number, y: number): Promise<void> {
    await this.sendRequest({
      type: 'RdpMouseMove',
      payload: { connection_id: connectionId, x, y },
    });
  }

  async rdpMouseDrag(
    connectionId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'RdpMouseDrag',
      payload: { connection_id: connectionId, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY, button },
    });
  }

  async rdpGetDimensions(connectionId: string): Promise<{ width: number; height: number }> {
    const response = await this.sendRequest({
      type: 'RdpGetDimensions',
      payload: { connection_id: connectionId },
    });
    return { width: response.width as number, height: response.height as number };
  }

  async rdpMouseScroll(
    connectionId: string,
    x: number,
    y: number,
    delta: number,
    vertical: boolean,
  ): Promise<void> {
    await this.sendRequest({
      type: 'RdpMouseScroll',
      payload: { connection_id: connectionId, x, y, delta, vertical },
    });
  }

  async rdpResize(connectionId: string, width: number, height: number): Promise<{ width: number; height: number }> {
    const response = await this.sendRequest({
      type: 'RdpResize',
      payload: { connection_id: connectionId, width, height },
    });
    return { width: response.width as number, height: response.height as number };
  }

  // ---------- VNC operations ----------

  async vncScreenshot(connectionId: string, format: string, quality: number, maxWidth: number | null = null): Promise<string> {
    const response = await this.sendRequest({
      type: 'VncScreenshot',
      payload: { connection_id: connectionId, format, quality, max_width: maxWidth },
    });
    return response.image as string;
  }

  async vncClick(
    connectionId: string,
    x: number,
    y: number,
    button: string,
    doubleClick: boolean,
  ): Promise<void> {
    await this.sendRequest({
      type: 'VncClick',
      payload: { connection_id: connectionId, x, y, button, double_click: doubleClick },
    });
  }

  async vncType(connectionId: string, text: string): Promise<void> {
    await this.sendRequest({
      type: 'VncType',
      payload: { connection_id: connectionId, text },
    });
  }

  async vncSendKey(
    connectionId: string,
    key: string,
    modifiers: string[],
    action: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'VncSendKey',
      payload: { connection_id: connectionId, key, modifiers, action },
    });
  }

  async vncMouseMove(connectionId: string, x: number, y: number): Promise<void> {
    await this.sendRequest({
      type: 'VncMouseMove',
      payload: { connection_id: connectionId, x, y },
    });
  }

  async vncGetDimensions(connectionId: string): Promise<{ width: number; height: number }> {
    const response = await this.sendRequest({
      type: 'VncGetDimensions',
      payload: { connection_id: connectionId },
    });
    return { width: response.width as number, height: response.height as number };
  }

  async vncMouseScroll(
    connectionId: string,
    x: number,
    y: number,
    delta: number,
    vertical: boolean,
  ): Promise<void> {
    await this.sendRequest({
      type: 'VncMouseScroll',
      payload: { connection_id: connectionId, x, y, delta, vertical },
    });
  }

  async vncMouseDrag(
    connectionId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'VncMouseDrag',
      payload: { connection_id: connectionId, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY, button },
    });
  }

  // ---------- Web operations ----------

  async webScreenshot(
    connectionId: string,
    fullPage: boolean,
    format: string | null = null,
    quality: number | null = null,
    maxWidth: number | null = null,
  ): Promise<{ image: string; imageWidth: number; imageHeight: number }> {
    const response = await this.sendRequest({
      type: 'WebSessionScreenshot',
      payload: { session_id: connectionId, full_page: fullPage, format, quality, max_width: maxWidth },
    });
    return {
      image: (response.image as string) ?? '',
      imageWidth: (response.image_width as number) ?? 0,
      imageHeight: (response.image_height as number) ?? 0,
    };
  }

  async webReadContent(
    connectionId: string,
    selector: string | null,
    format: string,
  ): Promise<string> {
    const response = await this.sendRequest({
      type: 'WebSessionReadContent',
      payload: { session_id: connectionId, selector, format },
    });
    return (response.content as string) ?? '';
  }

  async webNavigate(connectionId: string, url: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionNavigate',
      payload: { session_id: connectionId, url },
    });
  }

  async webGetUrl(connectionId: string): Promise<string> {
    const response = await this.sendRequest({
      type: 'WebSessionGetUrl',
      payload: { session_id: connectionId },
    });
    return (response.url as string) ?? '';
  }

  async webGetTitle(connectionId: string): Promise<string> {
    const response = await this.sendRequest({
      type: 'WebSessionGetTitle',
      payload: { session_id: connectionId },
    });
    return (response.title as string) ?? '';
  }

  async webClick(
    connectionId: string,
    x: number,
    y: number,
    button: string,
    doubleClick: boolean,
  ): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionClick',
      payload: { session_id: connectionId, x, y, button, double_click: doubleClick },
    });
  }

  async webType(connectionId: string, text: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionType',
      payload: { session_id: connectionId, text },
    });
  }

  async webSendKey(
    connectionId: string,
    key: string,
    modifiers: string[],
    action: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionSendKey',
      payload: { session_id: connectionId, key, modifiers, action },
    });
  }

  async webMouseMove(connectionId: string, x: number, y: number): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionMouseMove',
      payload: { session_id: connectionId, x, y },
    });
  }

  async webMouseDrag(
    connectionId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: string,
  ): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionMouseDrag',
      payload: { session_id: connectionId, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY, button },
    });
  }

  async webMouseScroll(
    connectionId: string,
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionMouseScroll',
      payload: { session_id: connectionId, x, y, delta_x: deltaX, delta_y: deltaY },
    });
  }

  async webGetDimensions(connectionId: string): Promise<{ width: number; height: number }> {
    const response = await this.sendRequest({
      type: 'WebSessionGetDimensions',
      payload: { session_id: connectionId },
    });
    return { width: response.width as number, height: response.height as number };
  }

  async webClickElement(connectionId: string, selector: string): Promise<boolean> {
    const response = await this.sendRequest({
      type: 'WebSessionClickElement',
      payload: { session_id: connectionId, selector },
    });
    return response.clicked as boolean;
  }

  async webFillInput(connectionId: string, selector: string, value: string): Promise<boolean> {
    const response = await this.sendRequest({
      type: 'WebSessionFillInput',
      payload: { session_id: connectionId, selector, value },
    });
    return response.filled as boolean;
  }

  async webGetElements(connectionId: string): Promise<unknown> {
    const response = await this.sendRequest({
      type: 'WebSessionGetElements',
      payload: { session_id: connectionId },
    });
    return response.elements;
  }

  async webExecuteJs(connectionId: string, code: string): Promise<unknown> {
    const response = await this.sendRequest({
      type: 'WebSessionExecuteJs',
      payload: { session_id: connectionId, code },
    });
    return response.result;
  }

  // ---------- Web tab operations ----------

  async webListTabs(connectionId: string): Promise<{ tabs: unknown[]; activeTabId: string | null }> {
    const response = await this.sendRequest({
      type: 'WebSessionGetTabs',
      payload: { session_id: connectionId },
    });
    return {
      tabs: (response.tabs as unknown[]) ?? [],
      activeTabId: (response.active_tab_id as string) ?? null,
    };
  }

  async webCreateTab(connectionId: string, url?: string): Promise<{ tabId: string }> {
    const response = await this.sendRequest({
      type: 'WebSessionCreateTab',
      payload: { session_id: connectionId, url },
    });
    return { tabId: response.tab_id as string };
  }

  async webCloseTab(connectionId: string, tabId: string): Promise<{ lastTab: boolean }> {
    const response = await this.sendRequest({
      type: 'WebSessionCloseTab',
      payload: { session_id: connectionId, tab_id: tabId },
    });
    return { lastTab: (response.last_tab as boolean) ?? false };
  }

  async webSwitchTab(connectionId: string, tabId: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionSwitchTab',
      payload: { session_id: connectionId, tab_id: tabId },
    });
  }

  async webGoBack(connectionId: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionGoBack',
      payload: { session_id: connectionId },
    });
  }

  async webGoForward(connectionId: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionGoForward',
      payload: { session_id: connectionId },
    });
  }

  async webReload(connectionId: string): Promise<void> {
    await this.sendRequest({
      type: 'WebSessionReload',
      payload: { session_id: connectionId },
    });
  }

  // ---------- Command operations ----------

  async commandExecute(entryId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'CommandExecute',
      payload: { entry_id: entryId, timeout_ms: timeoutMs },
    });
  }

  // ---------- Entry operations ----------

  async entryGetInfo(id: string, includeNotes?: boolean): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'EntryGetInfo',
      payload: { id, include_notes: includeNotes ?? false },
    });
  }

  async entryGetDocument(id: string): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'EntryGetDocument',
      payload: { id },
    });
  }

  async entryUpdateNotes(id: string, notes: string): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'EntryUpdateNotes',
      payload: { id, notes },
    });
  }

  async documentCreate(
    name: string,
    content: string,
    folderId: string | null,
    tags: string[],
  ): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'DocumentCreate',
      payload: { name, content, folder_id: folderId, tags },
    });
  }

  async documentUpdate(
    id: string,
    content: string,
    name: string | null,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest({
      type: 'DocumentUpdate',
      payload: { id, content, name },
    });
  }
}
