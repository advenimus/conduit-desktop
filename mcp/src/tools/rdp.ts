/**
 * RDP MCP tools.
 *
 * Port of crates/conduit-mcp/src/tools/rdp.rs + server.rs RDP methods.
 *
 * Coordinate auto-scaling: screenshot tools downscale images to max_width for
 * efficient transmission. All coordinate-based tools (click, move, drag, scroll)
 * automatically scale from screenshot-space to native RDP resolution. Agents
 * simply use coordinates from the screenshot image — no manual scaling needed.
 */

import type { ConduitClient } from '../ipc-client.js';

// Per-connection scale factors from last screenshot
const scaleMap = new Map<string, { scaleX: number; scaleY: number }>();

/** Scale screenshot-space coordinates to native RDP resolution */
function scaleToNative(connectionId: string, x: number, y: number): { x: number; y: number } {
  const scale = scaleMap.get(connectionId);
  if (!scale) return { x, y }; // No screenshot taken yet — passthrough
  return {
    x: Math.round(x * scale.scaleX),
    y: Math.round(y * scale.scaleY),
  };
}

// ---------- rdp_screenshot ----------

export function rdpScreenshotDefinition() {
  return {
    name: 'rdp_screenshot',
    description: 'Capture a screenshot of an RDP session. Returns base64-encoded image. Images are automatically resized to max_width (default 1024px) and compressed as JPEG (default quality 40) to keep responses concise. All coordinate-based tools (click, move, drag, scroll) accept coordinates in the screenshot image space — no manual scaling needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
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
        region: {
          type: 'object',
          description: 'Optional capture region (coordinates in screenshot image space)',
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
  };
}

export async function rdpScreenshot(
  client: ConduitClient,
  args: {
    connection_id: string;
    format?: string;
    quality?: number;
    max_width?: number;
    region?: { x: number; y: number; width: number; height: number };
  },
): Promise<unknown> {
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 40;
  const maxWidth = args.max_width === 0 ? null : (args.max_width ?? 1024);

  // Scale region coordinates from screenshot space to native space before extracting
  let region: [number, number, number, number] | null = null;
  if (args.region) {
    const native = scaleToNative(args.connection_id, args.region.x, args.region.y);
    const nativeEnd = scaleToNative(args.connection_id, args.region.x + args.region.width, args.region.y + args.region.height);
    region = [native.x, native.y, nativeEnd.x - native.x, nativeEnd.y - native.y];
  }

  const result = await client.rdpScreenshot(args.connection_id, format, quality, region, maxWidth);
  const dims = await client.rdpGetDimensions(args.connection_id);

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
    width: imageWidth,
    height: imageHeight,
    native_width: dims.width,
    native_height: dims.height,
    timestamp: new Date().toISOString(),
  };
}

// ---------- rdp_click ----------

export function rdpClickDefinition() {
  return {
    name: 'rdp_click',
    description: 'Send a mouse click to an RDP session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
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

export async function rdpClick(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; button?: string; double_click?: boolean },
): Promise<unknown> {
  const button = args.button ?? 'left';
  const doubleClick = args.double_click ?? false;
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.rdpClick(args.connection_id, native.x, native.y, button, doubleClick);
  return { success: true, x: args.x, y: args.y, button };
}

// ---------- rdp_type ----------

export function rdpTypeDefinition() {
  return {
    name: 'rdp_type',
    description: 'Type text in an RDP session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        text: { type: 'string', description: 'Text to type' },
        delay_ms: {
          type: 'number',
          description: 'Delay between keystrokes in ms (default: 0)',
          default: 0,
        },
      },
      required: ['connection_id', 'text'],
    },
  };
}

export async function rdpType(
  client: ConduitClient,
  args: { connection_id: string; text: string; delay_ms?: number },
): Promise<unknown> {
  const delayMs = args.delay_ms ?? 0;
  await client.rdpType(args.connection_id, args.text, delayMs);
  return { success: true, characters_typed: args.text.length };
}

// ---------- rdp_send_key ----------

export function rdpSendKeyDefinition() {
  return {
    name: 'rdp_send_key',
    description: 'Send a keyboard event to an RDP session (key press, down, or up)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
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

export async function rdpSendKey(
  client: ConduitClient,
  args: { connection_id: string; key: string; modifiers?: string[]; action?: string },
): Promise<unknown> {
  const modifiers = args.modifiers ?? [];
  const action = args.action ?? 'press';
  await client.rdpSendKey(args.connection_id, args.key, modifiers, action);
  return { success: true, key: args.key, modifiers };
}

// ---------- rdp_mouse_move ----------

export function rdpMouseMoveDefinition() {
  return {
    name: 'rdp_mouse_move',
    description: 'Move the mouse cursor in an RDP session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        x: { type: 'number', description: 'Target X coordinate in screenshot image space' },
        y: { type: 'number', description: 'Target Y coordinate in screenshot image space' },
      },
      required: ['connection_id', 'x', 'y'],
    },
  };
}

export async function rdpMouseMove(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number },
): Promise<unknown> {
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.rdpMouseMove(args.connection_id, native.x, native.y);
  return { success: true, x: args.x, y: args.y };
}

// ---------- rdp_mouse_drag ----------

export function rdpMouseDragDefinition() {
  return {
    name: 'rdp_mouse_drag',
    description: 'Perform a mouse drag operation in an RDP session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
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

export async function rdpMouseDrag(
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
  await client.rdpMouseDrag(
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

// ---------- rdp_mouse_scroll ----------

export function rdpMouseScrollDefinition() {
  return {
    name: 'rdp_mouse_scroll',
    description: 'Send a mouse scroll event to an RDP session. Coordinates are in screenshot image space and automatically scaled to native resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
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

export async function rdpMouseScroll(
  client: ConduitClient,
  args: { connection_id: string; x: number; y: number; delta: number; vertical?: boolean },
): Promise<unknown> {
  const vertical = args.vertical ?? true;
  const native = scaleToNative(args.connection_id, args.x, args.y);
  await client.rdpMouseScroll(args.connection_id, native.x, native.y, args.delta, vertical);
  return { success: true, x: args.x, y: args.y, delta: args.delta, vertical };
}

// ---------- rdp_resize ----------

export function rdpResizeDefinition() {
  return {
    name: 'rdp_resize',
    description: 'Resize the RDP session display via RDPEDISP. Dimensions are clamped to 200-8192 and rounded to even numbers. Returns actual dimensions after clamping. Note: take a new screenshot after resizing to update the coordinate mapping.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
        width: { type: 'number', description: 'Desired display width in pixels' },
        height: { type: 'number', description: 'Desired display height in pixels' },
      },
      required: ['connection_id', 'width', 'height'],
    },
  };
}

export async function rdpResize(
  client: ConduitClient,
  args: { connection_id: string; width: number; height: number },
): Promise<unknown> {
  // Invalidate stale scale factors after resize
  scaleMap.delete(args.connection_id);
  const dims = await client.rdpResize(args.connection_id, args.width, args.height);
  return { success: true, width: dims.width, height: dims.height };
}

// ---------- rdp_get_dimensions ----------

export function rdpGetDimensionsDefinition() {
  return {
    name: 'rdp_get_dimensions',
    description: 'Get the native dimensions of an RDP session display',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connection_id: { type: 'string', description: 'UUID of the RDP session' },
      },
      required: ['connection_id'],
    },
  };
}

export async function rdpGetDimensions(
  client: ConduitClient,
  args: { connection_id: string },
): Promise<unknown> {
  const dims = await client.rdpGetDimensions(args.connection_id);
  return { width: dims.width, height: dims.height };
}
