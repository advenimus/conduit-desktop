/**
 * Unified tool registry — single source of truth for all AI-accessible tools.
 *
 * Adding a new tool:
 *   1. Add the IPC handler case in server.ts handleRequest()
 *   2. Add one ToolRegistryEntry to TOOL_REGISTRY below
 *   3. Done — the in-app AI automatically gets the tool
 */

import type { AppState } from '../state.js';

// ── Registry types ──────────────────────────────────────────────────────────

export type ToolCategory = 'read' | 'execute' | 'write' | 'navigate' | 'credential' | 'connection';

export interface ToolRegistryEntry {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: Record<string, unknown>;
  /** IPC request type for handleRequest(). Not needed if `execute` is provided. */
  ipcType?: string;
  /** Rename arg keys before sending to IPC (e.g., { connection_id: 'session_id' }). */
  argRenames?: Record<string, string>;
  /** Fill missing keys with these defaults before IPC dispatch. */
  defaults?: Record<string, unknown>;
  /** Full custom arg→payload transform. If provided, argRenames/defaults are skipped. */
  transformPayload?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Fully custom execution — bypasses IPC entirely. */
  execute?: (args: Record<string, unknown>, state: AppState) => Promise<string>;
}

// ── Registry ────────────────────────────────────────────────────────────────

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  // ─── Terminal tools ───────────────────────────────────────────────────

  {
    name: 'terminal_execute',
    category: 'execute',
    description: 'Execute a command in a terminal session and wait for completion',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        command: { type: 'string', description: 'Command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['connection_id', 'command'],
    },
    // Custom execute — write command, wait, read buffer
    execute: executeTerminalCommand,
  },
  {
    name: 'terminal_read_pane',
    category: 'read',
    description: 'Read the current terminal buffer content',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        lines: { type: 'number', description: 'Number of lines to read (default: 50)' },
        include_scrollback: { type: 'boolean', description: 'Include scrollback buffer (default: false)' },
      },
      required: ['connection_id'],
    },
    ipcType: 'TerminalReadBuffer',
    argRenames: { connection_id: 'session_id' },
    defaults: { lines: 50 },
  },
  {
    name: 'terminal_send_keys',
    category: 'execute',
    description: 'Send keyboard input to a terminal session, including control characters like \\x03 for Ctrl+C',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection/session' },
        keys: { type: 'string', description: 'Keys to send (supports \\x03 for Ctrl+C, etc.)' },
      },
      required: ['connection_id', 'keys'],
    },
    ipcType: 'TerminalWrite',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      data: Array.from(Buffer.from(args.keys as string)),
    }),
  },
  {
    name: 'local_shell_create',
    category: 'execute',
    description: 'Create a new local shell session on the machine running Conduit',
    parameters: {
      type: 'object',
      properties: {
        shell_type: { type: 'string', description: 'Shell type: bash, zsh, powershell, cmd (default: system default)' },
        working_directory: { type: 'string', description: 'Initial working directory' },
      },
      required: [],
    },
    ipcType: 'LocalShellCreate',
    defaults: { shell_type: null },
  },

  // ─── Connection tools ─────────────────────────────────────────────────

  {
    name: 'connection_list',
    category: 'read',
    description: 'List all connections (active and saved). Each entry includes id (session ID for terminal/RDP/VNC tools) and entry_id (vault entry ID for entry_info, entry_update_notes, document_read tools).',
    parameters: { type: 'object', properties: {}, required: [] },
    ipcType: 'ConnectionList',
  },
  {
    name: 'connection_open',
    category: 'connection',
    description: 'Open a new connection (SSH, RDP, or VNC)',
    parameters: {
      type: 'object',
      properties: {
        connection_type: { type: 'string', description: 'Connection type: ssh, rdp, vnc' },
        host: { type: 'string', description: 'Host to connect to' },
        port: { type: 'number', description: 'Port (default depends on type: SSH=22, RDP=3389, VNC=5900)' },
        credential_id: { type: 'string', description: 'Credential ID from the vault to use for authentication' },
        username: { type: 'string', description: 'Username for authentication (used if credential_id is not provided)' },
        password: { type: 'string', description: 'Password for authentication (used with username if credential_id is not provided)' },
        name: { type: 'string', description: 'Connection name (optional)' },
      },
      required: ['connection_type', 'host'],
    },
    ipcType: 'ConnectionOpen',
    defaults: { port: null, credential_id: null, username: null, password: null },
  },
  {
    name: 'connection_close',
    category: 'connection',
    description: 'Close an active connection',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the connection to close' },
      },
      required: ['connection_id'],
    },
    ipcType: 'ConnectionClose',
    argRenames: { connection_id: 'id' },
  },

  // ─── Credential tools ─────────────────────────────────────────────────

  {
    name: 'credential_list',
    category: 'read',
    description: 'List all stored credentials (metadata only, no secrets)',
    parameters: { type: 'object', properties: {}, required: [] },
    ipcType: 'CredentialList',
  },
  {
    name: 'credential_create',
    category: 'write',
    description: 'Store a new credential',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Credential name' },
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password (encrypted at rest)' },
        domain: { type: 'string', description: 'Domain (for Windows auth)' },
        private_key: { type: 'string', description: 'SSH private key' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for organization' },
      },
      required: ['name'],
    },
    ipcType: 'CredentialCreate',
    defaults: { username: null, password: null, domain: null, private_key: null, tags: [] },
  },
  {
    name: 'credential_read',
    category: 'credential',
    description: 'Retrieve a credential including secrets. REQUIRES USER APPROVAL.',
    parameters: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'UUID of the credential' },
        purpose: { type: 'string', description: 'Explanation for why the credential is needed (for user approval)' },
      },
      required: ['credential_id', 'purpose'],
    },
    // Custom execute — approval flow then fetch
    execute: executeCredentialRead,
  },
  {
    name: 'credential_delete',
    category: 'write',
    description: 'Delete a credential',
    parameters: {
      type: 'object',
      properties: {
        credential_id: { type: 'string', description: 'UUID of the credential to delete' },
      },
      required: ['credential_id'],
    },
    ipcType: 'CredentialDelete',
    argRenames: { credential_id: 'id' },
  },

  // ─── Web session tools ────────────────────────────────────────────────

  {
    name: 'website_screenshot',
    category: 'read',
    description: 'Capture a screenshot of a web session. Returns base64-encoded image.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        format: { type: 'string', description: 'Image format: "png" or "jpeg" (default: "png")' },
        full_page: { type: 'boolean', description: 'Capture full page including scrollable area (default: false)' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionScreenshot',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      full_page: (args.full_page as boolean) ?? false,
    }),
  },
  {
    name: 'website_read_content',
    category: 'read',
    description: 'Extract content from a web page by CSS selector or entire page',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: { type: 'string', description: 'CSS selector to extract content from (default: entire page)' },
        format: { type: 'string', description: 'Content format: "text", "html", or "markdown" (default: "text")' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionReadContent',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      selector: (args.selector as string) ?? null,
      format: (args.format as string) ?? 'text',
    }),
  },
  {
    name: 'website_navigate',
    category: 'navigate',
    description: 'Navigate to a URL in a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        url: { type: 'string', description: 'URL to navigate to' },
        wait_until: { type: 'string', description: 'Wait condition: "load", "domcontentloaded", "networkidle" (default: "load")' },
      },
      required: ['connection_id', 'url'],
    },
    ipcType: 'WebSessionNavigate',
    argRenames: { connection_id: 'session_id' },
  },

  {
    name: 'website_click',
    category: 'execute',
    description: 'Send a mouse click to a web session. Coordinates are in screenshot image space and auto-scaled.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Y coordinate in screenshot image space' },
        button: { type: 'string', description: 'Mouse button: "left", "right", or "middle" (default: "left")' },
        double_click: { type: 'boolean', description: 'Whether to double-click (default: false)' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'WebSessionClick',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      x: args.x,
      y: args.y,
      button: (args.button as string) ?? 'left',
      double_click: (args.double_click as boolean) ?? false,
    }),
  },
  {
    name: 'website_type',
    category: 'execute',
    description: 'Type text in a web session at the currently focused element',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['connection_id', 'text'],
    },
    ipcType: 'WebSessionType',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_send_key',
    category: 'execute',
    description: 'Send a keyboard event to a web session (key press, down, or up)',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "Escape", "F1", "a")' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers: "ctrl", "alt", "shift", "meta"' },
        action: { type: 'string', description: 'Action: "press", "down", or "up" (default: "press")' },
      },
      required: ['connection_id', 'key'],
    },
    ipcType: 'WebSessionSendKey',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      key: args.key,
      modifiers: (args.modifiers as string[]) ?? [],
      action: (args.action as string) ?? 'press',
    }),
  },
  {
    name: 'website_mouse_move',
    category: 'execute',
    description: 'Move the mouse cursor in a web session. Coordinates are in screenshot image space.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'Target X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Target Y coordinate in screenshot image space' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'WebSessionMouseMove',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_mouse_drag',
    category: 'execute',
    description: 'Perform a mouse drag operation in a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        from_x: { type: 'number', description: 'Starting X coordinate' },
        from_y: { type: 'number', description: 'Starting Y coordinate' },
        to_x: { type: 'number', description: 'Ending X coordinate' },
        to_y: { type: 'number', description: 'Ending Y coordinate' },
        button: { type: 'string', description: 'Mouse button (default: "left")' },
      },
      required: ['connection_id', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
    ipcType: 'WebSessionMouseDrag',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      from_x: args.from_x,
      from_y: args.from_y,
      to_x: args.to_x,
      to_y: args.to_y,
      button: (args.button as string) ?? 'left',
    }),
  },
  {
    name: 'website_mouse_scroll',
    category: 'execute',
    description: 'Send a mouse scroll event to a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        delta: { type: 'number', description: 'Scroll amount. Positive = up, negative = down.' },
      },
      required: ['connection_id', 'x', 'y', 'delta'],
    },
    ipcType: 'WebSessionMouseScroll',
    transformPayload: (args) => ({
      session_id: args.connection_id as string,
      x: args.x,
      y: args.y,
      delta_x: 0,
      delta_y: -((args.delta as number) ?? 0),
    }),
  },
  {
    name: 'website_get_dimensions',
    category: 'read',
    description: 'Get the viewport dimensions of a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionGetDimensions',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_click_element',
    category: 'execute',
    description: 'Click an element by CSS selector in a web session. Uses DOM click() — works even if off-screen.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['connection_id', 'selector'],
    },
    ipcType: 'WebSessionClickElement',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_fill_input',
    category: 'execute',
    description: 'Fill an input field by CSS selector. Sets value with native setter + dispatches input/change events for React/Vue/Angular compatibility.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: { type: 'string', description: 'CSS selector of the input element' },
        value: { type: 'string', description: 'Value to set on the input' },
      },
      required: ['connection_id', 'selector', 'value'],
    },
    ipcType: 'WebSessionFillInput',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_get_elements',
    category: 'read',
    description: 'Discover interactive elements on a web page: buttons, links, inputs, selects with text, selector, and bounds.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionGetElements',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_execute_js',
    category: 'execute',
    description: 'Execute JavaScript code in the web page context. Returns the result.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        code: { type: 'string', description: 'JavaScript code to execute in the page context' },
      },
      required: ['connection_id', 'code'],
    },
    ipcType: 'WebSessionExecuteJs',
    argRenames: { connection_id: 'session_id' },
  },

  // ─── Web tab management tools ────────────────────────────────────────

  {
    name: 'website_list_tabs',
    category: 'read',
    description: 'List all open tabs in a web session with their IDs, URLs, titles, and which tab is active',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionGetTabs',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_create_tab',
    category: 'navigate',
    description: 'Open a new tab in a web session. Optionally navigate to a URL. Max 12 tabs per session.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        url: { type: 'string', description: 'URL to open in the new tab (optional)' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionCreateTab',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_close_tab',
    category: 'navigate',
    description: 'Close a specific tab by ID in a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        tab_id: { type: 'string', description: 'ID of the tab to close' },
      },
      required: ['connection_id', 'tab_id'],
    },
    ipcType: 'WebSessionCloseTab',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_switch_tab',
    category: 'navigate',
    description: 'Switch the active tab in a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        tab_id: { type: 'string', description: 'ID of the tab to switch to' },
      },
      required: ['connection_id', 'tab_id'],
    },
    ipcType: 'WebSessionSwitchTab',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_go_back',
    category: 'navigate',
    description: 'Navigate the active tab backward in browser history',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionGoBack',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_go_forward',
    category: 'navigate',
    description: 'Navigate the active tab forward in browser history',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionGoForward',
    argRenames: { connection_id: 'session_id' },
  },
  {
    name: 'website_reload',
    category: 'navigate',
    description: 'Reload the active tab in a web session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'WebSessionReload',
    argRenames: { connection_id: 'session_id' },
  },

  // ─── RDP tools ────────────────────────────────────────────────────────

  {
    name: 'rdp_screenshot',
    category: 'read',
    description:
      'Capture a screenshot of an RDP session. Returns base64-encoded image. ' +
      'Images are automatically resized to max_width (default 1024px) and compressed as JPEG (default quality 40) to keep responses concise.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        format: { type: 'string', description: 'Image format: "png" or "jpeg" (default: "jpeg")' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default: 40). Lower values produce smaller images.' },
        max_width: { type: 'number', description: 'Maximum image width in pixels. Default: 1024. Set to 0 to disable resizing.' },
        region: {
          type: 'object',
          description: 'Optional capture region (coordinates in original RDP resolution)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['connection_id'],
    },
    ipcType: 'RdpScreenshot',
    transformPayload: (args) => {
      const region = args.region as { x: number; y: number; width: number; height: number } | undefined;
      return {
        connection_id: args.connection_id,
        format: (args.format as string) ?? 'jpeg',
        quality: (args.quality as number) ?? 40,
        max_width: args.max_width === 0 ? null : ((args.max_width as number) ?? 1024),
        region: region ? [region.x, region.y, region.width, region.height] : null,
      };
    },
  },
  {
    name: 'rdp_click',
    category: 'execute',
    description: 'Send a mouse click to an RDP session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        button: { type: 'string', description: 'Mouse button: "left", "right", or "middle" (default: "left")' },
        double_click: { type: 'boolean', description: 'Whether to double-click (default: false)' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'RdpClick',
    defaults: { button: 'left', double_click: false },
  },
  {
    name: 'rdp_type',
    category: 'execute',
    description: 'Type text in an RDP session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        text: { type: 'string', description: 'Text to type' },
        delay_ms: { type: 'number', description: 'Delay between keystrokes in ms (default: 0)' },
      },
      required: ['connection_id', 'text'],
    },
    ipcType: 'RdpType',
    defaults: { delay_ms: 0 },
  },
  {
    name: 'rdp_send_key',
    category: 'execute',
    description: 'Send a keyboard event to an RDP session (key press, down, or up)',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "F1", "a")' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers: "ctrl", "alt", "shift", "meta"' },
        action: { type: 'string', description: 'Action: "press", "down", or "up" (default: "press")' },
      },
      required: ['connection_id', 'key'],
    },
    ipcType: 'RdpSendKey',
    defaults: { modifiers: [], action: 'press' },
  },
  {
    name: 'rdp_mouse_move',
    category: 'execute',
    description: 'Move the mouse cursor in an RDP session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'RdpMouseMove',
  },
  {
    name: 'rdp_mouse_drag',
    category: 'execute',
    description: 'Perform a mouse drag operation in an RDP session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        from_x: { type: 'number', description: 'Starting X coordinate' },
        from_y: { type: 'number', description: 'Starting Y coordinate' },
        to_x: { type: 'number', description: 'Ending X coordinate' },
        to_y: { type: 'number', description: 'Ending Y coordinate' },
        button: { type: 'string', description: 'Mouse button (default: "left")' },
      },
      required: ['connection_id', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
    ipcType: 'RdpMouseDrag',
    defaults: { button: 'left' },
  },
  {
    name: 'rdp_mouse_scroll',
    category: 'execute',
    description: 'Send a mouse scroll event to an RDP session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        x: { type: 'number', description: 'X coordinate of the mouse' },
        y: { type: 'number', description: 'Y coordinate of the mouse' },
        delta: { type: 'number', description: 'Scroll amount. Positive = scroll up, negative = scroll down.' },
        vertical: { type: 'boolean', description: 'Whether to scroll vertically (default: true). Set false for horizontal scroll.' },
      },
      required: ['connection_id', 'x', 'y', 'delta'],
    },
    ipcType: 'RdpMouseScroll',
    defaults: { vertical: true },
  },
  {
    name: 'rdp_resize',
    category: 'execute',
    description: 'Resize the RDP session display. Dimensions are clamped to 200-8192 and rounded to even numbers.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        width: { type: 'number', description: 'Desired display width in pixels' },
        height: { type: 'number', description: 'Desired display height in pixels' },
      },
      required: ['connection_id', 'width', 'height'],
    },
    ipcType: 'RdpResize',
  },
  {
    name: 'rdp_get_dimensions',
    category: 'read',
    description: 'Get the dimensions of an RDP session display',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'RdpGetDimensions',
  },

  // ─── Entry tools ─────────────────────────────────────────────────────

  {
    name: 'entry_info',
    category: 'read',
    description: 'Get metadata for any vault entry (connection, document, command). Optionally include notes with !!secret!! values redacted.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry' },
        include_notes: { type: 'boolean', description: 'Include the entry notes field (secrets redacted). Default: false' },
      },
      required: ['entry_id'],
    },
    ipcType: 'EntryGetInfo',
    argRenames: { entry_id: 'id' },
  },
  {
    name: 'document_read',
    category: 'read',
    description: 'Read the markdown content of a document entry. !!secret!! values are automatically redacted.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the document entry' },
      },
      required: ['entry_id'],
    },
    ipcType: 'EntryGetDocument',
    argRenames: { entry_id: 'id' },
  },
  {
    name: 'entry_update_notes',
    category: 'write',
    description: 'Update the markdown notes on any vault entry. IMPORTANT: Always show the user what you plan to write and get their approval before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry to update' },
        notes: { type: 'string', description: 'New markdown notes content (replaces existing notes)' },
      },
      required: ['entry_id', 'notes'],
    },
    ipcType: 'EntryUpdateNotes',
    argRenames: { entry_id: 'id' },
  },
  {
    name: 'document_create',
    category: 'write',
    description: 'Create a new markdown document entry in the vault. IMPORTANT: Always show the user the proposed name and content, and get their approval before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name' },
        content: { type: 'string', description: 'Markdown content' },
        folder_id: { type: 'string', description: 'Folder UUID to create the document in (optional, defaults to vault root)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for organization' },
      },
      required: ['name', 'content'],
    },
    ipcType: 'DocumentCreate',
    defaults: { folder_id: null, tags: [] },
  },
  {
    name: 'document_update',
    category: 'write',
    description: 'Update the content of an existing markdown document entry. IMPORTANT: Always show the user the proposed changes and get their approval before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the document entry to update' },
        content: { type: 'string', description: 'New markdown content (replaces existing content)' },
        name: { type: 'string', description: 'New document name (optional, keeps existing if omitted)' },
      },
      required: ['entry_id', 'content'],
    },
    ipcType: 'DocumentUpdate',
    argRenames: { entry_id: 'id' },
  },

  // ─── VNC tools ────────────────────────────────────────────────────────

  {
    name: 'vnc_screenshot',
    category: 'read',
    description: 'Capture a screenshot of a VNC session. Returns base64-encoded image.',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        format: { type: 'string', description: 'Image format: "png" or "jpeg" (default: "png")' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default: 85)' },
      },
      required: ['connection_id'],
    },
    ipcType: 'VncScreenshot',
    defaults: { format: 'png', quality: 85 },
  },
  {
    name: 'vnc_click',
    category: 'execute',
    description: 'Send a mouse click to a VNC session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        button: { type: 'string', description: 'Mouse button: "left", "right", or "middle" (default: "left")' },
        double_click: { type: 'boolean', description: 'Whether to double-click (default: false)' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'VncClick',
    defaults: { button: 'left', double_click: false },
  },
  {
    name: 'vnc_type',
    category: 'execute',
    description: 'Type text in a VNC session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['connection_id', 'text'],
    },
    ipcType: 'VncType',
  },
  {
    name: 'vnc_send_key',
    category: 'execute',
    description: 'Send a keyboard event to a VNC session (key press, down, or up)',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "F1", "a")' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers: "ctrl", "alt", "shift", "meta"' },
        action: { type: 'string', description: 'Action: "press", "down", or "up" (default: "press")' },
      },
      required: ['connection_id', 'key'],
    },
    ipcType: 'VncSendKey',
    defaults: { modifiers: [], action: 'press' },
  },
  {
    name: 'vnc_mouse_move',
    category: 'execute',
    description: 'Move the mouse cursor in a VNC session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
      },
      required: ['connection_id', 'x', 'y'],
    },
    ipcType: 'VncMouseMove',
  },
  {
    name: 'vnc_mouse_drag',
    category: 'execute',
    description: 'Perform a mouse drag operation in a VNC session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        from_x: { type: 'number', description: 'Starting X coordinate' },
        from_y: { type: 'number', description: 'Starting Y coordinate' },
        to_x: { type: 'number', description: 'Ending X coordinate' },
        to_y: { type: 'number', description: 'Ending Y coordinate' },
        button: { type: 'string', description: 'Mouse button (default: "left")' },
      },
      required: ['connection_id', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
    ipcType: 'VncMouseDrag',
    defaults: { button: 'left' },
  },
  {
    name: 'vnc_mouse_scroll',
    category: 'execute',
    description: 'Send a mouse scroll event to a VNC session',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        x: { type: 'number', description: 'X coordinate of the mouse' },
        y: { type: 'number', description: 'Y coordinate of the mouse' },
        delta: { type: 'number', description: 'Scroll amount. Positive = scroll up, negative = scroll down.' },
        vertical: { type: 'boolean', description: 'Whether to scroll vertically (default: true). Set false for horizontal scroll.' },
      },
      required: ['connection_id', 'x', 'y', 'delta'],
    },
    ipcType: 'VncMouseScroll',
    defaults: { vertical: true },
  },
  {
    name: 'vnc_get_dimensions',
    category: 'read',
    description: 'Get the dimensions of a VNC session display',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
      },
      required: ['connection_id'],
    },
    ipcType: 'VncGetDimensions',
  },
];

// ── Custom execute functions ────────────────────────────────────────────────

/**
 * Execute a terminal command with polling for completion.
 * Writes command, waits for output to settle, then reads buffer.
 */
async function executeTerminalCommand(
  args: Record<string, unknown>,
  state: AppState,
): Promise<string> {
  const { handleRequest } = await import('../../ipc-server/server.js');

  const sessionId = args.connection_id as string;
  const command = args.command as string;
  const timeoutMs = (args.timeout_ms as number) ?? 30000;

  // Write the command
  const writeResult = await handleRequest({
    type: 'TerminalWrite',
    payload: {
      session_id: sessionId,
      data: Array.from(Buffer.from(`${command}\n`)),
    },
  }, state);

  if (writeResult.type === 'Error') {
    return JSON.stringify(writeResult.payload);
  }

  // Wait for output to settle
  await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 2000)));

  // Read the buffer
  const readResult = await handleRequest({
    type: 'TerminalReadBuffer',
    payload: { session_id: sessionId, lines: 100 },
  }, state);

  if (readResult.type === 'Error') {
    return JSON.stringify(readResult.payload);
  }

  const content = (readResult.payload as Record<string, unknown>).content as string;
  return JSON.stringify({ stdout: content, exit_code: 0, timed_out: false });
}

/**
 * Read a credential. Approval is now handled by the unified ToolApprovalService
 * gate in tool-bridge.ts before this function is called.
 */
async function executeCredentialRead(
  args: Record<string, unknown>,
  state: AppState,
): Promise<string> {
  const { handleRequest } = await import('../../ipc-server/server.js');

  const credResult = await handleRequest({
    type: 'CredentialGet',
    payload: { id: args.credential_id as string },
  }, state);

  if (credResult.type === 'Error') {
    return JSON.stringify(credResult.payload);
  }

  return JSON.stringify(credResult.payload);
}
