/**
 * VNC MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/vnc.rs + server.rs VNC methods.
 *
 * Coordinate auto-scaling: screenshot tools downscale images to max_width for
 * efficient transmission. All coordinate-based tools (click, move, drag, scroll)
 * automatically scale from screenshot-space to native VNC resolution. Agents
 * simply use coordinates from the screenshot image — no manual scaling needed.
 */

import type { ConduitClient } from '../ipc-client.js';

// Per-connection scale factors from last screenshot
const scaleMap = new Map<string, { scaleX: number; scaleY: number }>();

/** Scale screenshot-space coordinates to native VNC resolution */
function scaleToNative(connectionId: string, x: number, y: number): { x: number; y: number } {
  const scale = scaleMap.get(connectionId);
  if (!scale) return { x, y }; // No screenshot taken yet — passthrough
  return {
    x: Math.round(x * scale.scaleX),
    y: Math.round(y * scale.scaleY),
  };
}

// ---------- vnc_screenshot ----------

export function vncScreenshotDefinition() {
  return {
    name: 'vnc_screenshot',
    description: 'Capture a screenshot of a VNC session. Returns base64-encoded image. Images are automatically resized to max_width (default 1024px) and compressed as JPEG (default quality 40) to keep responses concise. All coordinate-based tools (click, move, drag, scroll) accept coordinates in the screenshot image space — no manual scaling needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
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

export async function vncScreenshot(
  client: ConduitClient,
  args: { connection_id: string; format?: string; quality?: number; max_width?: number },
): Promise<unknown> {
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 40;
  const maxWidth = args.max_width === 0 ? null : (args.max_width ?? 1024);

  const imageB64 = await client.vncScreenshot(args.connection_id, format, quality, maxWidth);
  const dims = await client.vncGetDimensions(args.connection_id);

  // VNC screenshots don't currently return image dimensions from the server,
  // so we compute the expected output size from native dims + maxWidth
  let imageWidth = dims.width;
  let imageHeight = dims.height;
  if (maxWidth && dims.width > maxWidth) {
    const scale = maxWidth / dims.width;
    imageWidth = maxWidth;
    imageHeight = Math.round(dims.height * scale);
  }

  // Store scale factors for coordinate auto-scaling
  if (imageWidth > 0 && imageHeight > 0) {
    scaleMap.set(args.connection_id, {
      scaleX: dims.width / imageWidth,
      scaleY: dims.height / imageHeight,
    });
  }

  return {
    image: imageB64,
    format,
    width: imageWidth,
    height: imageHeight,
    native_width: dims.width,
    native_height: dims.height,
    timestamp: new Date().toISOString(),
  };
}

// ---------- vnc_click ----------

export function vncClickDefinition() {
  return {
    name: 'vnc_click',
    description: 'Send a mouse click to a VNC session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
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

export async function vncClick(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; button?: string; double_click?: boolean },
): Promise<unknown> {
  const button = args.button ?? 'left';
  const doubleClick = args.double_click ?? false;
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.vncClick(args.connection_id, native.x, native.y, button, doubleClick);
  return { success: true, x: args.x, y: args.y, button };
}

// ---------- vnc_type ----------

export function vncTypeDefinition() {
  return {
    name: 'vnc_type',
    description: 'Type text in a VNC session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['connection_id', 'text'],
    },
  };
}

export async function vncType(
  client: ConduitClient,
  args: { connection_id: string; text: string },
): Promise<unknown> {
  await client.vncType(args.connection_id, args.text);
  return { success: true, characters_typed: args.text.length };
}

// ---------- vnc_send_key ----------

export function vncSendKeyDefinition() {
  return {
    name: 'vnc_send_key',
    description: 'Send a keyboard event to a VNC session (key press, down, or up)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        key: { type: 'string', description: 'Key name (e.g., "Enter", "Tab", "F1", "a")' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifiers: "ctrl", "alt", "shift", "meta"',
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

export async function vncSendKey(
  client: ConduitClient,
  args: { connection_id: string; key: string; modifiers?: string[]; action?: string },
): Promise<unknown> {
  const modifiers = args.modifiers ?? [];
  const action = args.action ?? 'press';
  await client.vncSendKey(args.connection_id, args.key, modifiers, action);
  return { success: true, key: args.key, modifiers };
}

// ---------- vnc_mouse_move ----------

export function vncMouseMoveDefinition() {
  return {
    name: 'vnc_mouse_move',
    description: 'Move the mouse cursor in a VNC session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        x: { type: 'number', description: 'Target X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Target Y coordinate in screenshot image space' },
      },
      required: ['connection_id', 'x', 'y'],
    },
  };
}

export async function vncMouseMove(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number },
): Promise<unknown> {
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.vncMouseMove(args.connection_id, native.x, native.y);
  return { success: true, x: args.x, y: args.y };
}

// ---------- vnc_mouse_scroll ----------

export function vncMouseScrollDefinition() {
  return {
    name: 'vnc_mouse_scroll',
    description: 'Send a mouse scroll event to a VNC session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
        x: { type: 'number', description: 'X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Y coordinate in screenshot image space' },
        delta: {
          type: 'number',
          description: 'Scroll amount. Positive = scroll up, negative = scroll down.',
        },
        vertical: {
          type: 'boolean',
          description: 'Whether to scroll vertically (default: true). Set false for horizontal scroll.',
          default: true,
        },
      },
      required: ['connection_id', 'x', 'y', 'delta'],
    },
  };
}

export async function vncMouseScroll(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; delta: number; vertical?: boolean },
): Promise<unknown> {
  const vertical = args.vertical ?? true;
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.vncMouseScroll(args.connection_id, native.x, native.y, args.delta, vertical);
  return { success: true, x: args.x, y: args.y, delta: args.delta, vertical };
}

// ---------- vnc_mouse_drag ----------

export function vncMouseDragDefinition() {
  return {
    name: 'vnc_mouse_drag',
    description: 'Perform a mouse drag operation in a VNC session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
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

export async function vncMouseDrag(
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
  const nativeFrom = scaleToNative(args.connection_id, args.from_x, args.from_y);
  const nativeTo = scaleToNative(args.connection_id, args.to_x, args.to_y);
  await client.vncMouseDrag(
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

// ---------- vnc_get_dimensions ----------

export function vncGetDimensionsDefinition() {
  return {
    name: 'vnc_get_dimensions',
    description: 'Get the native dimensions of a VNC session display',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the VNC session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function vncGetDimensions(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  const dims = await client.vncGetDimensions(args.connection_id);
  return { width: dims.width, height: dims.height };
}
