import { useEffect, useRef, useState, useCallback } from "react";
import { invoke, listen, type UnlistenFn } from "../../lib/electron";
import { useRemoteClipboard, type ClipboardFileInfo, type ClipboardFileProgress } from "../../hooks/useRemoteClipboard";
import { useSessionStore, type ConnectionStatus } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { toast } from "../common/Toast";
import { formatFileSize } from "../../lib/format";

interface DirtyRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

interface RdpFramePayload {
  sessionId: string;
  regions: DirtyRegion[];
}

interface RdpViewProps {
  sessionId: string;
  entryId?: string;
  isActive?: boolean;
  width: number;
  height: number;
  rdpMode?: string;
  enableHighDpi?: boolean;
  enableClipboard?: boolean;
  reconnecting?: boolean;
  status?: ConnectionStatus;
  connectionError?: string | null;
  onClose?: () => void;
}

/**
 * RDP session view component
 *
 * Renders the remote desktop display on a canvas and handles
 * mouse and keyboard input forwarding to the RDP session.
 */
export default function RdpView({ sessionId, entryId: _entryId, isActive = true, width: initialWidth, height: initialHeight, rdpMode, enableHighDpi, enableClipboard, reconnecting, status = "connected", connectionError, onClose }: RdpViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rdpWidth, setRdpWidth] = useState(initialWidth);
  const [rdpHeight, setRdpHeight] = useState(initialHeight);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [cursorStyle, setCursorStyle] = useState<string>("default");
  const isConnected = useRef(status === "connected");
  const [error, setError] = useState<string | null>(connectionError ?? null);

  // Toast IDs for file transfer notifications
  const fileToastIdRef = useRef<string | null>(null);
  const progressToastIdRef = useRef<string | null>(null);
  const lastProgressBytesRef = useRef<number>(0);
  const lastProgressTimeRef = useRef<number>(0);
  const lastSpeedRef = useRef<string | undefined>(undefined);
  const uploadCompleteShownRef = useRef<boolean>(false);

  // Bidirectional clipboard sync
  const handleRemoteFilesAvailable = useCallback((files: ClipboardFileInfo[]) => {
    // Dismiss any existing file toast
    if (fileToastIdRef.current) {
      toast.dismiss(fileToastIdRef.current);
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const fileList = files.slice(0, 3).map(f => f.name).join(", ") +
      (files.length > 3 ? ` +${files.length - 3} more` : "");

    fileToastIdRef.current = toast.info(
      `${files.length} file${files.length > 1 ? "s" : ""} from remote clipboard`,
      {
        message: `${fileList} (${formatFileSize(totalSize)})`,
        persistent: true,
        dismissOnAction: true,
        actions: [
          {
            label: "Download",
            variant: "primary",
            onClick: () => {
              // Reset speed tracking
              lastProgressBytesRef.current = 0;
              lastProgressTimeRef.current = 0;
              lastSpeedRef.current = undefined;
              invoke("rdp_clipboard_files_request", { sessionId }).catch((err) => {
                toast.error("Download failed", String(err));
              });
            },
          },
          {
            label: "Dismiss",
            onClick: () => {
              invoke("rdp_clipboard_files_dismiss", { sessionId }).catch(() => {});
            },
          },
        ],
      }
    );
  }, [sessionId]);

  const handleRemoteFilesComplete = useCallback((filePaths: string[]) => {
    // Dismiss progress toast
    if (progressToastIdRef.current) {
      toast.dismiss(progressToastIdRef.current);
      progressToastIdRef.current = null;
    }
    // Dismiss file available toast
    if (fileToastIdRef.current) {
      toast.dismiss(fileToastIdRef.current);
      fileToastIdRef.current = null;
    }

    toast.success(
      "Files downloaded",
      `${filePaths.length} file${filePaths.length > 1 ? "s" : ""} copied to clipboard`
    );
  }, []);

  const handleFileProgress = useCallback((progress: ClipboardFileProgress) => {
    // Reset the upload-complete guard when a new transfer starts:
    // - download (different direction), or
    // - fresh upload (low progress = new transfer, not trailing events)
    if (progress.direction === "download") {
      uploadCompleteShownRef.current = false;
    } else if (progress.direction === "upload" && uploadCompleteShownRef.current) {
      const pct = progress.totalSize > 0
        ? progress.bytesTransferred / progress.totalSize : 0;
      if (pct < 0.5) {
        // New upload starting — reset the guard
        uploadCompleteShownRef.current = false;
      } else {
        // Trailing events from completed upload — ignore
        return;
      }
    }

    const percent = progress.totalSize > 0
      ? Math.min(100, Math.round((progress.bytesTransferred / progress.totalSize) * 100))
      : 0;

    // Upload complete: server pulled all bytes — dismiss toast and show success.
    // For uploads, the server stops requesting chunks silently (no "done" event),
    // so we detect completion from progress nearing 100% on the last file.
    // Use 98% threshold: final progress events may be throttled or chunk boundaries
    // prevent bytesTransferred from exactly matching totalSize.
    if (progress.direction === "upload" && percent >= 98 &&
        progress.fileIndex + 1 >= progress.totalFiles) {
      uploadCompleteShownRef.current = true;
      if (progressToastIdRef.current) {
        toast.dismiss(progressToastIdRef.current);
        progressToastIdRef.current = null;
      }
      toast.success(
        "Sent to remote",
        `${progress.totalFiles} file${progress.totalFiles > 1 ? "s" : ""} copied to remote clipboard`
      );
      // Reset speed tracking
      lastProgressBytesRef.current = 0;
      lastProgressTimeRef.current = 0;
      lastSpeedRef.current = undefined;
      return;
    }

    // Calculate speed — only recalculate every 500ms+, otherwise keep last value
    const now = Date.now();
    const elapsed = now - lastProgressTimeRef.current;
    if (elapsed > 500 && lastProgressTimeRef.current > 0) {
      const bytesDelta = progress.bytesTransferred - lastProgressBytesRef.current;
      if (bytesDelta > 0) {
        const bytesPerSec = (bytesDelta / elapsed) * 1000;
        lastSpeedRef.current = `${formatFileSize(bytesPerSec)}/s`;
      }
      lastProgressBytesRef.current = progress.bytesTransferred;
      lastProgressTimeRef.current = now;
    } else if (lastProgressTimeRef.current === 0) {
      lastProgressBytesRef.current = progress.bytesTransferred;
      lastProgressTimeRef.current = now;
    }
    const speedStr = lastSpeedRef.current;

    const dirLabel = progress.direction === "download" ? "Downloading" : "Uploading";
    const fileLabel = progress.totalFiles > 1
      ? `File ${progress.fileIndex + 1}/${progress.totalFiles}`
      : undefined;
    const leftLabel = fileLabel ? `${fileLabel} — ${dirLabel}` : dirLabel;

    const title = progress.direction === "download"
      ? "Downloading from remote"
      : "Sending to remote";

    if (progressToastIdRef.current) {
      toast.update(progressToastIdRef.current, {
        title,
        progress: {
          percent,
          leftLabel,
          rightLabel: `${formatFileSize(progress.bytesTransferred)} / ${formatFileSize(progress.totalSize)}`,
          speed: speedStr,
        },
      });
    } else {
      progressToastIdRef.current = toast.info(title, {
        persistent: true,
        progress: {
          percent,
          leftLabel,
          rightLabel: `${formatFileSize(progress.bytesTransferred)} / ${formatFileSize(progress.totalSize)}`,
        },
      });
    }
  }, []);

  // Clean up toast refs on unmount
  useEffect(() => {
    return () => {
      if (fileToastIdRef.current) toast.dismiss(fileToastIdRef.current);
      if (progressToastIdRef.current) toast.dismiss(progressToastIdRef.current);
    };
  }, []);

  // Reset local error state when reconnecting (status transitions to "connecting")
  useEffect(() => {
    if (status === "connecting") {
      setError(null);
      isConnected.current = false;
    }
  }, [status]);

  useRemoteClipboard({
    sessionId,
    protocol: "rdp",
    isConnected: status === "connected",
    isActive,
    enabled: enableClipboard !== false,
    containerRef,
    onRemoteFilesAvailable: handleRemoteFilesAvailable,
    onRemoteFilesComplete: handleRemoteFilesComplete,
    onFileProgress: handleFileProgress,
  });

  /** Compute DPI-aware dimensions and scale factors for resize commands */
  const computeResizeParams = useCallback((containerW: number, containerH: number) => {
    const dpr = window.devicePixelRatio || 1;
    // Auto-detect: enable HiDPI on Retina displays unless explicitly disabled
    const isHighDpi = enableHighDpi !== false && dpr > 1;
    let w = containerW;
    let h = containerH;
    let desktopScaleFactor = 100;
    let deviceScaleFactor = 100;

    if (isHighDpi) {
      w = Math.round(containerW * dpr);
      h = Math.round(containerH * dpr);
      desktopScaleFactor = Math.min(500, Math.max(100, Math.round(dpr * 100)));
      if (dpr <= 1.2) deviceScaleFactor = 100;
      else if (dpr <= 1.6) deviceScaleFactor = 140;
      else deviceScaleFactor = 180;
    }

    // Apply user display scale (> 1.0 = fewer pixels = bigger objects)
    const displayScale = useSettingsStore.getState().sessionDefaultsRdp.displayScale ?? 1.0;
    if (displayScale !== 1.0) {
      w = Math.max(800, Math.round(w / displayScale));
      h = Math.max(600, Math.round(h / displayScale));
    }

    return { width: w, height: h, desktopScaleFactor, deviceScaleFactor };
  }, [enableHighDpi]);

  // Sync status prop to internal refs/state
  useEffect(() => {
    isConnected.current = status === "connected";
    if (status === "disconnected" && connectionError) {
      setError(connectionError);
    }
  }, [status, connectionError]);

  // Sync dimensions when props change (e.g. connecting→connected transition)
  useEffect(() => {
    setRdpWidth(initialWidth);
    setRdpHeight(initialHeight);
  }, [initialWidth, initialHeight]);

  // Handle frame updates from the RDP session
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<RdpFramePayload>(
          "rdp:frame",
          (event) => {
            if (event.payload.sessionId === sessionId && canvasRef.current) {
              const ctx = canvasRef.current.getContext("2d", {
                willReadFrequently: false,
                alpha: false,
              });

              if (ctx) {
                // Direct rendering - original working code
                for (const region of event.payload.regions) {
                  const bytes = region.data as Uint8Array;
                  const clamped = new Uint8ClampedArray(
                    bytes.buffer as ArrayBuffer,
                    bytes.byteOffset,
                    bytes.byteLength
                  );
                  const imageData = new ImageData(clamped, region.width, region.height);
                  ctx.putImageData(imageData, region.x, region.y);
                }
              }
            }
          }
        );
        isConnected.current = true;

        // Request a full frame for initial paint
        if (status === "connected") {
          invoke("rdp_request_frame", { sessionId }).catch(() => {});
        }
      } catch (err) {
        console.error("Failed to set up RDP frame listener:", err);
        setError(err instanceof Error ? err.message : "Failed to connect");
      }
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  // Listen for session status changes (e.g., unexpected disconnect from resize crash)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen<{ sessionId: string; status: string; error: string | null }>(
      "rdp:status",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          if (event.payload.status === "disconnected") {
            // Ignore disconnect events while reconnecting — the reconnect flow
            // triggers rdp_disconnect which emits this event, but we don't want
            // to show the error screen during the reconnection process.
            const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
            if (session?.metadata?.reconnecting) return;

            setError(event.payload.error || "Session disconnected");
            isConnected.current = false;
          }
        }
      }
    ).then((fn) => { unlisten = fn; });

    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // Listen for server-initiated resize events (RDPEDISP)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen<{ sessionId: string; width: number; height: number }>(
      "rdp:resize",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          console.log(`[RdpView] server resize event: ${event.payload.width}x${event.payload.height}`);
          setRdpWidth(event.payload.width);
          setRdpHeight(event.payload.height);
          // Persist to session metadata so remounted views start with correct dims
          useSessionStore.getState().updateSessionMetadata(sessionId, {
            rdpWidth: event.payload.width,
            rdpHeight: event.payload.height,
          });
          // Request full frame at new resolution for clean rendering
          invoke("rdp_request_frame", { sessionId }).catch(() => {});
        }
      }
    ).then((fn) => { unlisten = fn; });

    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // Listen for cursor updates from the RDP session
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen<{ sessionId: string; type: string; dataUrl?: string; hotspotX?: number; hotspotY?: number; scale?: number }>(
      "rdp:cursor",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          switch (event.payload.type) {
            case "set":
              if (event.payload.dataUrl) {
                const hotX = event.payload.hotspotX ?? 0;
                const hotY = event.payload.hotspotY ?? 0;
                const dprScale = event.payload.scale ?? 1;

                if (dprScale > 1) {
                  // Use -webkit-image-set for crisp Retina cursors: the browser
                  // renders the full-res image at 1/dprScale CSS size using native pixels
                  setCursorStyle(
                    `-webkit-image-set(url(${event.payload.dataUrl}) ${dprScale}x) ${hotX} ${hotY}, auto`
                  );
                } else {
                  setCursorStyle(
                    `url(${event.payload.dataUrl}) ${hotX} ${hotY}, auto`
                  );
                }
              }
              break;
            case "null":
              setCursorStyle("none");
              break;
            case "default":
              setCursorStyle("default");
              break;
          }
        }
      }
    ).then((fn) => { unlisten = fn; });

    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  // Request full frame when tab becomes active or status changes to connected
  // Also trigger a resize check — container may have changed size while hidden
  useEffect(() => {
    if (isActive && status === "connected") {
      invoke("rdp_request_frame", { sessionId }).catch(() => {});
      // Trigger resize checks after DOM settles — container may have expanded while we were hidden
      const timers = [
        setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 50),
        setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 200),
        setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 500),
      ];
      return () => timers.forEach(clearTimeout);
    }
  }, [isActive, status, sessionId]);

  // Periodic resize retry — catches cases where resize requests were dropped
  useEffect(() => {
    if (status !== "connected") return;

    const intervalId = setInterval(() => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      // Skip if container is hidden
      if (cw === 0 || ch === 0) return;
      const params = computeResizeParams(cw, ch);
      const diffW = Math.abs(params.width - rdpWidth);
      const diffH = Math.abs(params.height - rdpHeight);
      if (diffW > 10 || diffH > 10) {
        console.log(`[RdpView] periodic retry: target=${params.width}x${params.height} rdp=${rdpWidth}x${rdpHeight}`);
        invoke("rdp_resize", {
          sessionId,
          width: params.width,
          height: params.height,
          desktopScaleFactor: params.desktopScaleFactor,
          deviceScaleFactor: params.deviceScaleFactor,
        }).catch(() => {});
      }
    }, 3000);

    return () => clearInterval(intervalId);
  }, [rdpWidth, rdpHeight, sessionId, status, computeResizeParams]);

  // Handle container resize — CSS scale for immediate feedback + debounced native resize
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.clientWidth;
      const containerHeight = containerRef.current.clientHeight;

      // Skip if container is hidden (display:none gives 0 dimensions)
      if (containerWidth === 0 || containerHeight === 0) return;

      const scaleX = containerWidth / rdpWidth;
      const scaleY = containerHeight / rdpHeight;
      setScale(Math.min(scaleX, scaleY, 1));

      // Debounced native resize via RDPEDISP
      if (status === "connected") {
        const params = computeResizeParams(containerWidth, containerHeight);
        // Only trigger if target dims differ meaningfully from RDP resolution
        const diffW = Math.abs(params.width - rdpWidth);
        const diffH = Math.abs(params.height - rdpHeight);
        if (diffW > 10 || diffH > 10) {
          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => {
            resizeTimerRef.current = null;
            console.log(`[RdpView] ResizeObserver: requesting ${params.width}x${params.height} (was ${rdpWidth}x${rdpHeight})`);
            invoke("rdp_resize", {
              sessionId,
              width: params.width,
              height: params.height,
              desktopScaleFactor: params.desktopScaleFactor,
              deviceScaleFactor: params.deviceScaleFactor,
            }).catch(() => {});
          }, 300);
        }
      }
    };

    updateScale();

    const resizeObserver = new ResizeObserver(updateScale);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [rdpWidth, rdpHeight, sessionId, status, computeResizeParams]);

  // Track latest rdp dims in a ref so layout-changed handler always has current values
  const rdpDimsRef = useRef({ width: rdpWidth, height: rdpHeight });
  rdpDimsRef.current = { width: rdpWidth, height: rdpHeight };

  // Listen for layout changes (split/unsplit/resize) to trigger RDP resize
  useEffect(() => {
    if (status !== "connected") return;

    const tryResize = () => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      if (cw === 0 || ch === 0) return;
      const params = computeResizeParams(cw, ch);
      const curW = rdpDimsRef.current.width;
      const curH = rdpDimsRef.current.height;
      const diffW = Math.abs(params.width - curW);
      const diffH = Math.abs(params.height - curH);
      if (diffW > 10 || diffH > 10) {
        console.log(`[RdpView] layout-changed: requesting ${params.width}x${params.height} (was ${curW}x${curH})`);
        invoke("rdp_resize", {
          sessionId,
          width: params.width,
          height: params.height,
          desktopScaleFactor: params.desktopScaleFactor,
          deviceScaleFactor: params.deviceScaleFactor,
        }).catch(() => {});
      }

      // Also update CSS scale immediately
      const scaleX = cw / curW;
      const scaleY = ch / curH;
      setScale(Math.min(scaleX, scaleY, 1));
    };

    let timers: ReturnType<typeof setTimeout>[] = [];
    const handleLayoutChanged = () => {
      // Try at multiple intervals to catch post-render DOM updates
      tryResize();
      timers.forEach(clearTimeout);
      timers = [
        setTimeout(tryResize, 50),
        setTimeout(tryResize, 200),
        setTimeout(tryResize, 500),
      ];
    };

    document.addEventListener("conduit:layout-changed", handleLayoutChanged);
    return () => {
      document.removeEventListener("conduit:layout-changed", handleLayoutChanged);
      timers.forEach(clearTimeout);
    };
  }, [sessionId, status, computeResizeParams]);

  // Listen for devicePixelRatio changes (e.g., window moved to different-DPR monitor)
  useEffect(() => {
    const isHighDpi = enableHighDpi !== false && (window.devicePixelRatio || 1) > 1;
    if (!isHighDpi || status !== "connected") return;

    const mqString = `(resolution: ${window.devicePixelRatio}dppx)`;
    const mq = matchMedia(mqString);

    const handleDprChange = () => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const params = computeResizeParams(cw, ch);
      console.log(`[RdpView] DPR changed to ${window.devicePixelRatio}, resizing to ${params.width}x${params.height}`);
      invoke("rdp_resize", {
        sessionId,
        width: params.width,
        height: params.height,
        desktopScaleFactor: params.desktopScaleFactor,
        deviceScaleFactor: params.deviceScaleFactor,
      }).catch(() => {});
    };

    mq.addEventListener("change", handleDprChange);
    return () => mq.removeEventListener("change", handleDprChange);
  }, [enableHighDpi, sessionId, status, computeResizeParams]);

  // Convert screen coordinates to RDP coordinates
  const toRdpCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      if (!canvasRef.current) return { x: 0, y: 0 };

      const rect = canvasRef.current.getBoundingClientRect();
      const x = Math.round((clientX - rect.left) / scale);
      const y = Math.round((clientY - rect.top) / scale);

      return {
        x: Math.max(0, Math.min(x, rdpWidth - 1)),
        y: Math.max(0, Math.min(y, rdpHeight - 1)),
      };
    },
    [scale, rdpWidth, rdpHeight]
  );

  // Convert mouse button number to string
  const getButtonName = (button: number): string => {
    switch (button) {
      case 0: return "left";
      case 1: return "middle";
      case 2: return "right";
      default: return "left";
    }
  };

  // Handle mouse down
  const handleMouseDown = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = toRdpCoords(e.clientX, e.clientY);
    const button = getButtonName(e.button);

    try {
      await invoke("rdp_mouse_down", { sessionId, x, y, button });
    } catch (err) {
      console.error("Mouse down error:", err);
    }
  };

  // Handle mouse up
  const handleMouseUp = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = toRdpCoords(e.clientX, e.clientY);
    const button = getButtonName(e.button);

    try {
      await invoke("rdp_mouse_up", { sessionId, x, y, button });
    } catch (err) {
      console.error("Mouse up error:", err);
    }
  };

  // Handle mouse move (throttled)
  const lastMoveRef = useRef<number>(0);
  const handleMouseMove = async (e: React.MouseEvent) => {
    // Throttle mouse moves to ~60fps
    const now = Date.now();
    if (now - lastMoveRef.current < 16) return;
    lastMoveRef.current = now;

    const { x, y } = toRdpCoords(e.clientX, e.clientY);

    try {
      await invoke("rdp_mouse_move", { sessionId, x, y });
    } catch {
      // Ignore frequent move errors
    }
  };

  // Handle mouse wheel with native listener (passive: false).
  // Attached to the container div (not canvas) so the listener survives canvas
  // replacement during transient re-renders. Uses refs for frequently-changing
  // values so the effect only re-runs on sessionId/status changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = async (e: WheelEvent) => {
      e.preventDefault(); // Works because passive: false
      const canvas = canvasRef.current;
      if (!canvas) return;

      const currentScale = scaleRef.current;
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      const x = Math.round(clientX / currentScale);
      const y = Math.round(clientY / currentScale);

      // Convert browser wheel delta to RDP scroll units.
      // RDP positive = scroll up, browser positive deltaY = scroll down, so negate.
      // Windows WHEEL_DELTA = 120 per notch; clamp to ±120 per event.
      let rdpDelta: number;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Mouse wheel: each line ≈ one notch = 120 RDP units
        rdpDelta = Math.round(-e.deltaY * 120);
      } else {
        // Trackpad pixel scroll: scale for reasonable speed
        rdpDelta = Math.round(-e.deltaY * 3);
      }
      rdpDelta = Math.max(-120, Math.min(120, rdpDelta));
      if (rdpDelta === 0) return;

      try {
        await invoke("rdp_mouse_scroll", { sessionId, x, y, deltaY: rdpDelta, vertical: true });
      } catch (err) {
        console.error("Mouse scroll error:", err);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [sessionId, status]);

  // Handle key down
  const handleKeyDown = async (e: React.KeyboardEvent) => {
    e.preventDefault();

    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push("ctrl");
    if (e.altKey) modifiers.push("alt");
    if (e.shiftKey) modifiers.push("shift");
    if (e.metaKey) modifiers.push("meta");

    try {
      await invoke("rdp_key_down", {
        sessionId,
        key: e.key,
        code: e.code,
        modifiers,
      });
    } catch (err) {
      console.error("Key down error:", err);
    }
  };

  // Handle key up
  const handleKeyUp = async (e: React.KeyboardEvent) => {
    e.preventDefault();

    try {
      await invoke("rdp_key_up", {
        sessionId,
        key: e.key,
        code: e.code,
      });
    } catch (err) {
      console.error("Key up error:", err);
    }
  };

  // Prevent context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // Focus the container when clicked
  const handleContainerClick = () => {
    containerRef.current?.focus();
  };

  // Re-focus when tab becomes active
  useEffect(() => {
    if (isActive) {
      containerRef.current?.focus();
    }
  }, [isActive]);

  if (rdpMode === "xfreerdp") {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-canvas text-ink-muted">
        <div className="text-lg mb-2">RDP Session Active</div>
        <div className="text-sm text-ink-faint mb-1">
          Connected via FreeRDP (external window)
        </div>
        <div className="text-xs text-ink-faint">
          Server requires NLA — using xfreerdp subprocess
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="mt-4 px-4 py-2 bg-raised hover:bg-raised rounded text-sm"
          >
            Disconnect
          </button>
        )}
      </div>
    );
  }

  // Connecting state — spinner
  if (status === "connecting") {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-canvas text-ink-muted">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink-muted mb-4" />
        <div className="text-sm font-medium">
          {reconnecting ? "Reconnecting..." : "Connecting to RDP session..."}
        </div>
        {reconnecting && (
          <div className="text-xs text-ink-faint mt-2">
            Waiting for server to release previous session
          </div>
        )}
      </div>
    );
  }

  // Disconnected with error
  if (error || status === "disconnected") {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-canvas text-ink-muted">
        <div className="text-red-400 mb-2">Connection Error</div>
        <div className="text-sm">{error ?? "Disconnected"}</div>
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
      className="h-full w-full flex items-center justify-center bg-canvas overflow-hidden outline-none relative"
      tabIndex={0}
      onClick={handleContainerClick}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <canvas
        ref={canvasRef}
        width={rdpWidth}
        height={rdpHeight}
        style={{
          cursor: cursorStyle,
          transform: `scale(${scale})`,
          transformOrigin: "center",
          imageRendering: "auto",
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onContextMenu={handleContextMenu}
      />
      {rdpMode && (
        <div className="absolute bottom-1 right-2 text-[10px] text-white/20 pointer-events-none select-none">
          FreeRDP
        </div>
      )}
    </div>
  );
}

