import { useEffect, useRef, useState, useCallback } from "react";
import { invoke, listen, type UnlistenFn } from "../../lib/electron";
import {
  keyToKeysym,
  charToKeysym,
  needsShift,
  Keysyms,
} from "../../lib/vnc-keysyms";

// noVNC's RFB class — CJS module with default export
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RFB: any = null;

interface VncViewProps {
  sessionId: string;
  isActive?: boolean;
  onClose?: () => void;
}

interface McpRequest {
  requestId: string;
  sessionId: string;
  action: string;
  params: Record<string, unknown>;
}

/**
 * VNC session view using noVNC.
 *
 * noVNC handles all RFB protocol decoding, canvas rendering, mouse/keyboard
 * input, and clipboard natively in the renderer. The main process provides
 * only a WebSocket-to-TCP bridge.
 *
 * Supports both standard VNC (password-only auth) and macOS Screen Sharing
 * (ARD auth type 30 = username+password). noVNC selects the auth type
 * automatically based on server-offered security types.
 */
export default function VncView({
  sessionId,
  isActive = true,
  onClose,
}: VncViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<InstanceType<typeof RFB> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectingRef = useRef(false);

  // ── Load noVNC module lazily ─────────────────────────────────────
  const loadRFB = useCallback(async () => {
    if (RFB) return RFB;
    const mod = await import("@novnc/novnc/lib/rfb.js");
    RFB = mod.default || mod;
    return RFB;
  }, []);

  // ── Connect to VNC via noVNC ────────────────────────────────────
  useEffect(() => {
    if (connectingRef.current) return;
    connectingRef.current = true;

    let rfb: InstanceType<typeof RFB> | null = null;
    let destroyed = false;

    const connect = async () => {
      try {
        const RFBClass = await loadRFB();

        const info = await invoke<{
          wsUrl: string;
          credentials: { password?: string; username?: string };
        }>("vnc_get_ws_info", { sessionId });

        if (destroyed) return;
        if (!containerRef.current) return;
        if (!info.wsUrl) return;

        // Build credentials object for noVNC
        const credentials: Record<string, string> = {};
        if (info.credentials.password) {
          credentials.password = info.credentials.password;
        }
        if (info.credentials.username) {
          credentials.username = info.credentials.username;
        }

        rfb = new RFBClass(containerRef.current, info.wsUrl, {
          credentials,
          shared: true,
        });
        rfbRef.current = rfb;

        // Enable viewport scaling (fits to container, GPU-accelerated CSS scaling)
        rfb.scaleViewport = true;
        rfb.resizeSession = false;

        // ── noVNC events ────────────────────────────────────────

        rfb.addEventListener("connect", () => {
          if (destroyed) return;
          setIsConnected(true);
          setError(null);

          // Report to main process
          const width = rfb._fbWidth || 0;
          const height = rfb._fbHeight || 0;
          const serverName = rfb._fbName || "";
          invoke("vnc_notify_connected", {
            sessionId,
            width,
            height,
            serverName,
          }).catch(() => {});
        });

        rfb.addEventListener(
          "disconnect",
          (e: CustomEvent<{ clean: boolean }>) => {
            if (destroyed) return;
            setIsConnected(false);
            const errorMsg = e.detail.clean
              ? undefined
              : "Connection lost";
            if (errorMsg) setError(errorMsg);
            invoke("vnc_notify_disconnected", {
              sessionId,
              error: errorMsg,
            }).catch(() => {});
          }
        );

        rfb.addEventListener(
          "credentialsrequired",
          (e: CustomEvent<{ types: string[] }>) => {
            if (destroyed) return;
            const required = e.detail.types;
            const missing = required.filter((t) => !credentials[t]);

            if (missing.length === 0) {
              // We have all required credentials — provide them again
              // (shouldn't normally happen, but handles edge cases)
              rfb?.sendCredentials(credentials);
              return;
            }

            // Show a specific error based on what's missing
            if (missing.includes("username") && missing.includes("password")) {
              setError("Server requires username and password");
            } else if (missing.includes("username")) {
              setError(
                "This VNC server requires a username (macOS Screen Sharing). " +
                "Update the entry's credential to include both username and password."
              );
            } else if (missing.includes("password")) {
              setError("Server requires a password");
            } else {
              setError(`Server requires: ${missing.join(", ")}`);
            }
            rfb?.disconnect();
          }
        );

        rfb.addEventListener(
          "clipboard",
          (e: CustomEvent<{ text: string }>) => {
            if (destroyed) return;
            navigator.clipboard.writeText(e.detail.text).catch(() => {});
          }
        );

        rfb.addEventListener("desktopname", () => {
          // Could update session title if needed
        });
      } catch (err) {
        if (!destroyed) {
          const msg =
            err instanceof Error ? err.message : "Failed to connect";
          setError(msg);
        }
      }
    };

    connect();

    return () => {
      destroyed = true;
      connectingRef.current = false;
      if (rfb) {
        try {
          // Only disconnect if not already disconnected (avoids noVNC warning)
          if (rfb._rfbConnectionState !== "disconnected") {
            rfb.disconnect();
          }
        } catch {
          /* ignore */
        }
        rfbRef.current = null;
      }
    };
  }, [sessionId, loadRFB]);

  // ── Sync local clipboard to remote on focus/active ──────────────
  useEffect(() => {
    if (!isConnected || !isActive) return;
    const rfb = rfbRef.current;
    if (!rfb) return;

    const syncClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) rfb.clipboardPasteFrom(text);
      } catch {
        /* clipboard API may not be available */
      }
    };

    const handleFocus = () => syncClipboard();
    const el = containerRef.current;
    el?.addEventListener("focus", handleFocus);

    // Also sync immediately when tab becomes active
    syncClipboard();

    return () => {
      el?.removeEventListener("focus", handleFocus);
    };
  }, [isConnected, isActive]);

  // ── Focus noVNC canvas when tab becomes active ──────────────────
  useEffect(() => {
    if (isActive && rfbRef.current) {
      rfbRef.current.focus();
    }
  }, [isActive]);

  // ── MCP action handler ──────────────────────────────────────────
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const setupListener = async () => {
      unlisten = await listen<McpRequest>("vnc:mcp_request", (event) => {
        const { requestId, sessionId: reqSessionId, action, params } =
          event.payload;

        if (reqSessionId !== sessionId) return;

        handleMcpAction(requestId, action, params);
      });
    };

    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, [sessionId, isConnected]);

  const handleMcpAction = useCallback(
    async (
      requestId: string,
      action: string,
      params: Record<string, unknown>
    ) => {
      const rfb = rfbRef.current;
      if (!rfb) {
        invoke("vnc_mcp_response", {
          requestId,
          error: "VNC not connected",
        }).catch(() => {});
        return;
      }

      try {
        let result: unknown;

        switch (action) {
          case "screenshot": {
            const canvas = rfb._canvas as HTMLCanvasElement;
            if (!canvas) throw new Error("Canvas not available");
            const format = (params.format as string) || "png";
            const mimeType =
              format === "jpeg" ? "image/jpeg" : "image/png";
            const quality =
              format === "jpeg"
                ? ((params.quality as number) || 85) / 100
                : undefined;
            const dataUrl = canvas.toDataURL(mimeType, quality);
            const base64 = dataUrl.split(",")[1] || "";
            result = base64;
            break;
          }

          case "click": {
            const x = params.x as number;
            const y = params.y as number;
            const button = (params.button as string) || "left";
            dispatchMouseClick(rfb, x, y, button);
            result = { success: true };
            break;
          }

          case "mouseMove": {
            const x = params.x as number;
            const y = params.y as number;
            dispatchMouseEvent(rfb, "mousemove", x, y, 0);
            result = { success: true };
            break;
          }

          case "mouseScroll": {
            const x = params.x as number;
            const y = params.y as number;
            const deltaY = params.deltaY as number;
            dispatchWheelEvent(rfb, x, y, deltaY);
            result = { success: true };
            break;
          }

          case "mouseDrag": {
            const fromX = params.from_x as number;
            const fromY = params.from_y as number;
            const toX = params.to_x as number;
            const toY = params.to_y as number;
            const btn = (params.button as string) || "left";
            dispatchMouseDrag(rfb, fromX, fromY, toX, toY, btn);
            result = { success: true };
            break;
          }

          case "type": {
            const text = params.text as string;
            typeText(rfb, text);
            result = { success: true };
            break;
          }

          case "sendKey": {
            const key = params.key as string;
            const modifiers = (params.modifiers || {}) as {
              ctrl?: boolean;
              alt?: boolean;
              shift?: boolean;
              meta?: boolean;
            };
            sendKeyWithModifiers(rfb, key, modifiers);
            result = { success: true };
            break;
          }

          case "getDimensions": {
            const canvas = rfb._canvas as HTMLCanvasElement;
            result = {
              width: rfb._fbWidth || canvas?.width || 0,
              height: rfb._fbHeight || canvas?.height || 0,
            };
            break;
          }

          case "clipboard": {
            const text = params.text as string;
            rfb.clipboardPasteFrom(text);
            result = { success: true };
            break;
          }

          default:
            throw new Error(`Unknown MCP action: ${action}`);
        }

        invoke("vnc_mcp_response", { requestId, result }).catch(() => {});
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        invoke("vnc_mcp_response", { requestId, error: msg }).catch(
          () => {}
        );
      }
    },
    []
  );

  if (error) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-canvas text-ink-muted">
        <div className="text-red-400 mb-2">Connection Error</div>
        <div className="text-sm max-w-md text-center">{error}</div>
        {onClose && (
          <button
            onClick={onClose}
            className="mt-4 px-4 py-2 bg-raised hover:bg-raised rounded text-sm"
          >
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-session-keyboard
      className="h-full w-full bg-canvas overflow-hidden outline-none"
      tabIndex={0}
    >
      {!isConnected && (
        <div className="h-full w-full flex flex-col items-center justify-center text-ink-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink-muted mb-4" />
          <div>Connecting to VNC session...</div>
        </div>
      )}
    </div>
  );
}

// ── Mouse/keyboard helpers for MCP actions ────────────────────────────

function buttonNameToNum(button: string): number {
  switch (button) {
    case "left":
      return 0;
    case "middle":
      return 1;
    case "right":
      return 2;
    default:
      return 0;
  }
}

/** Convert VNC logical coords to DOM client coords on the noVNC canvas */
function vncToClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rfb: any,
  vncX: number,
  vncY: number
): { clientX: number; clientY: number } {
  const canvas = rfb._canvas as HTMLCanvasElement;
  if (!canvas) return { clientX: 0, clientY: 0 };

  const rect = canvas.getBoundingClientRect();
  const fbWidth = rfb._fbWidth || canvas.width;
  const fbHeight = rfb._fbHeight || canvas.height;

  const scaleX = rect.width / fbWidth;
  const scaleY = rect.height / fbHeight;

  return {
    clientX: rect.left + vncX * scaleX,
    clientY: rect.top + vncY * scaleY,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchMouseEvent(rfb: any, type: string, vncX: number, vncY: number, button: number): void {
  const canvas = rfb._canvas as HTMLCanvasElement;
  if (!canvas) return;

  const { clientX, clientY } = vncToClient(rfb, vncX, vncY);

  canvas.dispatchEvent(
    new PointerEvent(type === "mousemove" ? "pointermove" : type === "mousedown" ? "pointerdown" : "pointerup", {
      clientX,
      clientY,
      button,
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
    })
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchMouseClick(rfb: any, vncX: number, vncY: number, button: string): void {
  const btn = buttonNameToNum(button);
  dispatchMouseEvent(rfb, "mousedown", vncX, vncY, btn);
  dispatchMouseEvent(rfb, "mouseup", vncX, vncY, btn);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchWheelEvent(rfb: any, vncX: number, vncY: number, deltaY: number): void {
  const canvas = rfb._canvas as HTMLCanvasElement;
  if (!canvas) return;

  const { clientX, clientY } = vncToClient(rfb, vncX, vncY);
  const clicks = Math.abs(Math.round(deltaY));

  for (let i = 0; i < clicks; i++) {
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        clientX,
        clientY,
        deltaY: deltaY > 0 ? -120 : 120,
        bubbles: true,
        cancelable: true,
      })
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchMouseDrag(rfb: any, fromX: number, fromY: number, toX: number, toY: number, button: string): void {
  const btn = buttonNameToNum(button);
  const steps = 10;

  dispatchMouseEvent(rfb, "mousedown", fromX, fromY, btn);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(fromX + (toX - fromX) * t);
    const y = Math.round(fromY + (toY - fromY) * t);
    dispatchMouseEvent(rfb, "mousemove", x, y, btn);
  }
  dispatchMouseEvent(rfb, "mouseup", toX, toY, btn);
}

/** Type a string by sending individual key events via noVNC's sendKey API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typeText(rfb: any, text: string): void {
  for (const char of text) {
    const keysym = charToKeysym(char);
    if (keysym === 0) continue;

    const shifted = needsShift(char);
    if (shifted) {
      rfb.sendKey(Keysyms.Shift_L, "ShiftLeft", true);
    }
    rfb.sendKey(keysym, null);
    if (shifted) {
      rfb.sendKey(Keysyms.Shift_L, "ShiftLeft", false);
    }
  }
}

/** Send a named key with optional modifiers via noVNC's sendKey API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendKeyWithModifiers(
  rfb: any,
  key: string,
  modifiers: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
  }
): void {
  if (modifiers.ctrl) rfb.sendKey(Keysyms.Control_L, "ControlLeft", true);
  if (modifiers.alt) rfb.sendKey(Keysyms.Alt_L, "AltLeft", true);
  if (modifiers.shift) rfb.sendKey(Keysyms.Shift_L, "ShiftLeft", true);
  if (modifiers.meta) rfb.sendKey(Keysyms.Meta_L, "MetaLeft", true);

  const keysym = keyToKeysym(key);
  if (keysym !== 0) {
    rfb.sendKey(keysym, null);
  }

  if (modifiers.meta) rfb.sendKey(Keysyms.Meta_L, "MetaLeft", false);
  if (modifiers.shift) rfb.sendKey(Keysyms.Shift_L, "ShiftLeft", false);
  if (modifiers.alt) rfb.sendKey(Keysyms.Alt_L, "AltLeft", false);
  if (modifiers.ctrl) rfb.sendKey(Keysyms.Control_L, "ControlLeft", false);
}
