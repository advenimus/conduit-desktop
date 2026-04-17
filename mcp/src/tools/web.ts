/**
 * Web session MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/web.rs + server.rs web methods.
 *
 * Coordinate auto-scaling: screenshot tools downscale images to max_width for
 * efficient transmission. All coordinate-based tools (click, move, drag, scroll)
 * automatically scale from screenshot-space to CSS viewport space. Agents
 * simply use coordinates from the screenshot image — no manual scaling needed.
 */

import type { ConduitClient } from '../ipc-client.js';

// Per-connection scale factors from last screenshot
const scaleMap = new Map<string, { scaleX: number; scaleY: number }>();

/** Scale screenshot-space coordinates to CSS viewport coordinates */
function scaleToViewport(connectionId: string, x: number, y: number): { x: number; y: number } {
  const scale = scaleMap.get(connectionId);
  if (!scale) return { x, y }; // No screenshot taken yet — passthrough
  return {
    x: Math.round(x * scale.scaleX),
    y: Math.round(y * scale.scaleY),
  };
}

// ---------- website_screenshot ----------

export function websiteScreenshotDefinition() {
  return {
    name: 'website_screenshot',
    description: 'Capture a screenshot of a web session. Returns base64-encoded image. Images are automatically resized to max_width (default 1024px) and compressed as JPEG (default quality 40) to keep responses concise. All coordinate-based tools (click, move, drag, scroll) accept coordinates in the screenshot image space — no manual scaling needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        full_page: {
          type: 'boolean',
          description: 'Capture full page including scrollable area (default: false)',
          default: false,
        },
        format: {
          type: 'string',
          description: 'Image format: "png" or "jpeg" (default: "jpeg")',
          default: 'jpeg',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default: 40). Lower values produce smaller images.',
          default: 40,
        },
        max_width: {
          type: 'number',
          description: 'Maximum image width in pixels. Images wider than this are downscaled preserving aspect ratio. Default: 1024. Set to 0 to disable resizing.',
          default: 1024,
        },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteScreenshot(
  client: ConduitClient,
  args: { connection_id: string; full_page?: boolean; format?: string; quality?: number; max_width?: number },
): Promise<unknown> {
  const fullPage = args.full_page ?? false;
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 40;
  const maxWidth = args.max_width === 0 ? null : (args.max_width ?? 1024);

  const result = await client.webScreenshot(args.connection_id, fullPage, format, quality, maxWidth);
  const dims = await client.webGetDimensions(args.connection_id);
  const url = await client.webGetUrl(args.connection_id);

  // Store scale factors for coordinate auto-scaling
  const imageWidth = result.imageWidth;
  const imageHeight = result.imageHeight;
  if (imageWidth > 0 && imageHeight > 0) {
    scaleMap.set(args.connection_id, {
      scaleX: dims.width / imageWidth,
      scaleY: dims.height / imageHeight,
    });
  }

  return {
    image: result.image,
    format,
    url,
    width: imageWidth,
    height: imageHeight,
    viewport_width: dims.width,
    viewport_height: dims.height,
  };
}

// ---------- website_read_content ----------

export function websiteReadContentDefinition() {
  return {
    name: 'website_read_content',
    description: 'Extract content from a web page by CSS selector or entire page',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: {
          type: 'string',
          description: 'CSS selector to extract content from (default: entire page)',
        },
        format: {
          type: 'string',
          description: 'Content format: "text", "html", or "markdown" (default: "text")',
          default: 'text',
        },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteReadContent(
  client: ConduitClient,
  args: { connection_id: string; selector?: string; format?: string },
): Promise<unknown> {
  const format = args.format ?? 'text';
  const content = await client.webReadContent(args.connection_id, args.selector ?? null, format);
  const url = await client.webGetUrl(args.connection_id);
  const title = await client.webGetTitle(args.connection_id);

  return { content, url, title };
}

// ---------- website_navigate ----------

export function websiteNavigateDefinition() {
  return {
    name: 'website_navigate',
    description: 'Navigate to a URL in a web session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        url: { type: 'string', description: 'URL to navigate to' },
        wait_until: {
          type: 'string',
          description:
            'Wait condition: "load", "domcontentloaded", "networkidle" (default: "load")',
        },
      },
      required: ['connection_id', 'url'],
    },
  };
}

export async function websiteNavigate(
  client: ConduitClient,
  args: { connection_id: string; url: string },
): Promise<unknown> {
  // Invalidate stale scale factors after navigation
  scaleMap.delete(args.connection_id);
  await client.webNavigate(args.connection_id, args.url);

  // Brief wait for navigation
  await new Promise((r) => setTimeout(r, 500));

  const currentUrl = await client.webGetUrl(args.connection_id);
  const title = await client.webGetTitle(args.connection_id);

  return {
    success: true,
    url: currentUrl,
    title,
  };
}

// ---------- website_click ----------

export function websiteClickDefinition() {
  return {
    name: 'website_click',
    description: 'Send a mouse click to a web session. Coordinates are in screenshot image space and automatically scaled to viewport coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Y coordinate in screenshot image space' },
        button: {
          type: 'string',
          description: 'Mouse button: "left", "right", or "middle" (default: "left")',
          default: 'left',
        },
        double_click: {
          type: 'boolean',
          description: 'Whether to double-click (default: false)',
          default: false,
        },
      },
      required: ['connection_id', 'x', 'y'],
    },
  };
}

export async function websiteClick(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; button?: string; double_click?: boolean },
): Promise<unknown> {
  const button = args.button ?? 'left';
  const doubleClick = args.double_click ?? false;
  const native = scaleToViewport(args.connection_id, args.x, args.y);
  await client.webClick(args.connection_id, native.x, native.y, button, doubleClick);
  return { success: true, x: args.x, y: args.y, button };
}

// ---------- website_type ----------

export function websiteTypeDefinition() {
  return {
    name: 'website_type',
    description: 'Type text in a web session. Text is inserted at the currently focused element using insertText (handles Unicode correctly).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['connection_id', 'text'],
    },
  };
}

export async function websiteType(
  client: ConduitClient,
  args: { connection_id: string; text: string },
): Promise<unknown> {
  await client.webType(args.connection_id, args.text);
  return { success: true, characters_typed: args.text.length };
}

// ---------- website_send_key ----------

export function websiteSendKeyDefinition() {
  return {
    name: 'website_send_key',
    description: 'Send a keyboard event to a web session (key press, down, or up). Use for keyboard shortcuts and special keys.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "Escape", "F1", "a")' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifiers: "ctrl", "alt", "shift", "meta" (or "cmd")',
          default: [],
        },
        action: {
          type: 'string',
          description: 'Action: "press", "down", or "up" (default: "press")',
          default: 'press',
        },
      },
      required: ['connection_id', 'key'],
    },
  };
}

export async function websiteSendKey(
  client: ConduitClient,
  args: { connection_id: string; key: string; modifiers?: string[]; action?: string },
): Promise<unknown> {
  const modifiers = args.modifiers ?? [];
  const action = args.action ?? 'press';
  await client.webSendKey(args.connection_id, args.key, modifiers, action);
  return { success: true, key: args.key, modifiers };
}

// ---------- website_mouse_move ----------

export function websiteMouseMoveDefinition() {
  return {
    name: 'website_mouse_move',
    description: 'Move the mouse cursor in a web session. Coordinates are in screenshot image space and automatically scaled to viewport coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'Target X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Target Y coordinate in screenshot image space' },
      },
      required: ['connection_id', 'x', 'y'],
    },
  };
}

export async function websiteMouseMove(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number },
): Promise<unknown> {
  const native = scaleToViewport(args.connection_id, args.x, args.y);
  await client.webMouseMove(args.connection_id, native.x, native.y);
  return { success: true, x: args.x, y: args.y };
}

// ---------- website_mouse_drag ----------

export function websiteMouseDragDefinition() {
  return {
    name: 'website_mouse_drag',
    description: 'Perform a mouse drag operation in a web session. Coordinates are in screenshot image space and automatically scaled to viewport coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        from_x: { type: 'number', description: 'Starting X coordinate in screenshot image space' },
        from_y: { type: 'number', description: 'Starting Y coordinate in screenshot image space' },
        to_x: { type: 'number', description: 'Ending X coordinate in screenshot image space' },
        to_y: { type: 'number', description: 'Ending Y coordinate in screenshot image space' },
        button: {
          type: 'string',
          description: 'Mouse button (default: "left")',
          default: 'left',
        },
      },
      required: ['connection_id', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
  };
}

export async function websiteMouseDrag(
  client: ConduitClient,
  args: {
    connection_id: string;
    from_x: number;
    from_y: number;
    to_x: number;
    to_y: number;
    button?: string;
  },
): Promise<unknown> {
  const button = args.button ?? 'left';
  const nativeFrom = scaleToViewport(args.connection_id, args.from_x, args.from_y);
  const nativeTo = scaleToViewport(args.connection_id, args.to_x, args.to_y);
  await client.webMouseDrag(
    args.connection_id,
    nativeFrom.x,
    nativeFrom.y,
    nativeTo.x,
    nativeTo.y,
    button,
  );
  return {
    success: true,
    from_x: args.from_x,
    from_y: args.from_y,
    to_x: args.to_x,
    to_y: args.to_y,
  };
}

// ---------- website_mouse_scroll ----------

export function websiteMouseScrollDefinition() {
  return {
    name: 'website_mouse_scroll',
    description: 'Send a mouse scroll event to a web session. Coordinates are in screenshot image space and automatically scaled to viewport coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        x: { type: 'number', description: 'X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Y coordinate in screenshot image space' },
        delta: {
          type: 'number',
          description: 'Scroll amount. Positive = scroll up, negative = scroll down.',
        },
      },
      required: ['connection_id', 'x', 'y', 'delta'],
    },
  };
}

export async function websiteMouseScroll(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; delta: number },
): Promise<unknown> {
  const native = scaleToViewport(args.connection_id, args.x, args.y);
  // delta positive = scroll up = negative deltaY in Electron
  await client.webMouseScroll(args.connection_id, native.x, native.y, 0, -args.delta);
  return { success: true, x: args.x, y: args.y, delta: args.delta };
}

// ---------- website_get_dimensions ----------

export function websiteGetDimensionsDefinition() {
  return {
    name: 'website_get_dimensions',
    description: 'Get the viewport dimensions of a web session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteGetDimensions(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  const dims = await client.webGetDimensions(args.connection_id);
  return { width: dims.width, height: dims.height };
}

// ---------- website_click_element ----------

export function websiteClickElementDefinition() {
  return {
    name: 'website_click_element',
    description: 'Click an element by CSS selector in a web session. Uses DOM click() — works even if element is off-screen.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['connection_id', 'selector'],
    },
  };
}

export async function websiteClickElement(
  client: ConduitClient,
  args: { connection_id: string; selector: string },
): Promise<unknown> {
  const clicked = await client.webClickElement(args.connection_id, args.selector);
  return { success: true, clicked };
}

// ---------- website_fill_input ----------

export function websiteFillInputDefinition() {
  return {
    name: 'website_fill_input',
    description: 'Fill an input field by CSS selector in a web session. Sets the value using native setter and dispatches input/change events for React/Vue/Angular compatibility.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        selector: { type: 'string', description: 'CSS selector of the input element' },
        value: { type: 'string', description: 'Value to set on the input' },
      },
      required: ['connection_id', 'selector', 'value'],
    },
  };
}

export async function websiteFillInput(
  client: ConduitClient,
  args: { connection_id: string; selector: string; value: string },
): Promise<unknown> {
  const filled = await client.webFillInput(args.connection_id, args.selector, args.value);
  return { success: true, filled };
}

// ---------- website_get_elements ----------

export function websiteGetElementsDefinition() {
  return {
    name: 'website_get_elements',
    description: 'Discover interactive elements on a web page: buttons, links, inputs, selects. Returns element metadata including text, selector, and bounding box coordinates (in viewport CSS pixels).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteGetElements(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  const elements = await client.webGetElements(args.connection_id);
  return { elements };
}

// ---------- website_execute_js ----------

export function websiteExecuteJsDefinition() {
  return {
    name: 'website_execute_js',
    description: 'Execute JavaScript code in the web page context. Returns the result of the expression. Use for advanced page inspection or interaction not covered by other tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        code: { type: 'string', description: 'JavaScript code to execute in the page context' },
      },
      required: ['connection_id', 'code'],
    },
  };
}

export async function websiteExecuteJs(
  client: ConduitClient,
  args: { connection_id: string; code: string },
): Promise<unknown> {
  const result = await client.webExecuteJs(args.connection_id, args.code);
  return { result };
}

// ---------- website_list_tabs ----------

export function websiteListTabsDefinition() {
  return {
    name: 'website_list_tabs',
    description: 'List all open tabs in a web session with their IDs, URLs, titles, and which tab is active. Use this to discover tabs before switching.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteListTabs(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  const result = await client.webListTabs(args.connection_id);
  return { tabs: result.tabs, active_tab_id: result.activeTabId };
}

// ---------- website_create_tab ----------

export function websiteCreateTabDefinition() {
  return {
    name: 'website_create_tab',
    description: 'Open a new tab in a web session. Optionally navigate to a URL. Maximum 12 tabs per session. The new tab becomes the active tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        url: { type: 'string', description: 'URL to open in the new tab (optional — opens blank tab if omitted)' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteCreateTab(
  client: ConduitClient,
  args: { connection_id: string; url?: string },
): Promise<unknown> {
  // Invalidate stale scale factors — new tab has different content
  scaleMap.delete(args.connection_id);
  const result = await client.webCreateTab(args.connection_id, args.url);
  return { success: true, tab_id: result.tabId };
}

// ---------- website_close_tab ----------

export function websiteCloseTabDefinition() {
  return {
    name: 'website_close_tab',
    description: 'Close a specific tab by ID in a web session. If the closed tab was active, another tab becomes active.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        tab_id: { type: 'string', description: 'ID of the tab to close (from website_list_tabs)' },
      },
      required: ['connection_id', 'tab_id'],
    },
  };
}

export async function websiteCloseTab(
  client: ConduitClient,
  args: { connection_id: string; tab_id: string },
): Promise<unknown> {
  // Invalidate stale scale factors — active tab may change
  scaleMap.delete(args.connection_id);
  const result = await client.webCloseTab(args.connection_id, args.tab_id);
  return { success: true, last_tab: result.lastTab };
}

// ---------- website_switch_tab ----------

export function websiteSwitchTabDefinition() {
  return {
    name: 'website_switch_tab',
    description: 'Switch the active tab in a web session. After switching, all coordinate-based tools (screenshot, click, type, etc.) operate on the new active tab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
        tab_id: { type: 'string', description: 'ID of the tab to switch to (from website_list_tabs)' },
      },
      required: ['connection_id', 'tab_id'],
    },
  };
}

export async function websiteSwitchTab(
  client: ConduitClient,
  args: { connection_id: string; tab_id: string },
): Promise<unknown> {
  // Invalidate stale scale factors — new active tab has different dimensions/content
  scaleMap.delete(args.connection_id);
  await client.webSwitchTab(args.connection_id, args.tab_id);
  return { success: true };
}

// ---------- website_go_back ----------

export function websiteGoBackDefinition() {
  return {
    name: 'website_go_back',
    description: 'Navigate the active tab backward in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteGoBack(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  scaleMap.delete(args.connection_id);
  await client.webGoBack(args.connection_id);
  return { success: true };
}

// ---------- website_go_forward ----------

export function websiteGoForwardDefinition() {
  return {
    name: 'website_go_forward',
    description: 'Navigate the active tab forward in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteGoForward(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  scaleMap.delete(args.connection_id);
  await client.webGoForward(args.connection_id);
  return { success: true };
}

// ---------- website_reload ----------

export function websiteReloadDefinition() {
  return {
    name: 'website_reload',
    description: 'Reload the active tab in a web session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the web session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function websiteReload(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  scaleMap.delete(args.connection_id);
  await client.webReload(args.connection_id);
  return { success: true };
}
