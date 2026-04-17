/**
 * Controls when a web session's native WebContentsView should be live vs frozen.
 *
 * Core principle: the native view is ONLY attached to the window when ALL
 * conditions are met. In every other state, the session renders as a static
 * screenshot <img> in HTML-land where z-ordering works naturally.
 *
 * Two-path transition strategy:
 *   Path A — Session deactivated (isActive → false): Container is display:none,
 *            so no visual continuity is needed. Hide immediately, capture in background.
 *   Path B — Visual freeze (overlay/sidebar/drag while active): Session is still
 *            visible. Use atomic capture+hide IPC with safety timeout + onError handler.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "../lib/electron";

interface UseNativeViewVisibilityOptions {
  sessionId: string;
  /** Whether this session is the active tab in its pane */
  isActive: boolean;
  /** Whether the underlying WebContentsView has been created */
  webviewReady: boolean;
  /** Re-sync the native view's position/size to match the container */
  syncBounds: () => Promise<void>;
}

interface NativeViewVisibility {
  /** True when the native view should be attached (live). False = show screenshot. */
  shouldBeNative: boolean;
  /** Data URL of the frozen screenshot, or null if native view is live */
  frozenScreenshot: string | null;
  /** Callback for <img onLoad> — hides the native view once the screenshot is painted */
  onScreenshotLoaded: () => void;
  /** Callback for <img onError> — clears broken screenshot and ensures native view is hidden */
  onScreenshotError: () => void;
}

export function useNativeViewVisibility({
  sessionId,
  isActive,
  webviewReady,
  syncBounds,
}: UseNativeViewVisibilityOptions): NativeViewVisibility {
  // ── External state tracked via events ──────────────────────────
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [frozenScreenshot, setFrozenScreenshot] = useState<string | null>(null);

  // Ref to track the last boundsKey so we can force a re-sync after restore
  const lastBoundsRef = useRef("");

  // Track previous isActive to detect deactivation (Path A)
  const prevIsActiveRef = useRef(isActive);

  // ── Derive the single visibility boolean ───────────────────────
  const shouldBeNative =
    isActive && !overlayOpen && !sidebarOverlay && !dragActive && webviewReady;

  // Keep a ref so async callbacks can read the latest value
  const shouldBeNativeRef = useRef(shouldBeNative);
  shouldBeNativeRef.current = shouldBeNative;

  // ── Event listeners — pure state setters, no side effects ──────
  useEffect(() => {
    const handler = (e: Event) => setOverlayOpen(!!(e as CustomEvent).detail);
    document.addEventListener("conduit:overlay-change", handler);
    return () => document.removeEventListener("conduit:overlay-change", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => setSidebarOverlay(!!(e as CustomEvent).detail);
    document.addEventListener("conduit:sidebar-overlay-change", handler);
    return () => document.removeEventListener("conduit:sidebar-overlay-change", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => setDragActive(!!(e as CustomEvent).detail);
    document.addEventListener("conduit:drag-change", handler);
    return () => document.removeEventListener("conduit:drag-change", handler);
  }, []);

  // Helper: ensure the native view is hidden (idempotent)
  const ensureHidden = useCallback(() => {
    invoke("web_session_hide", { sessionId }).catch(() => {});
  }, [sessionId]);

  // ── Single transition effect ───────────────────────────────────
  useEffect(() => {
    if (!webviewReady) return;

    let cancelled = false;

    if (shouldBeNative) {
      // TRANSITION TO NATIVE: show the real view, clear screenshot
      lastBoundsRef.current = ""; // force re-sync
      syncBounds()
        .then(() => {
          if (!cancelled) return invoke("web_session_show", { sessionId });
        })
        .catch(() => {
          if (!cancelled) invoke("web_session_show", { sessionId }).catch(() => {});
        });
      // Clear screenshot on next frame — native view renders above it instantly
      requestAnimationFrame(() => {
        if (!cancelled) setFrozenScreenshot(null);
      });
    } else {
      // TRANSITION AWAY FROM NATIVE

      // Detect whether isActive just flipped to false (Path A)
      const wasActive = prevIsActiveRef.current;
      const isDeactivation = wasActive && !isActive;

      if (isDeactivation) {
        // ── Path A: Session deactivated (container is display:none) ──
        // No visual continuity needed — hide immediately.
        ensureHidden();
        // Capture screenshot in background for when session becomes active again
        invoke<string>("web_session_capture_page", { sessionId })
          .then((dataUrl) => {
            if (!cancelled && dataUrl && dataUrl.length > 100) {
              setFrozenScreenshot(dataUrl);
            }
          })
          .catch(() => {});
      } else {
        // ── Path B: Visual freeze (overlay/sidebar/drag opened while active) ──
        // Session is still visible. Use atomic capture+hide for seamless swap.
        // Safety timeout: if capture+hide takes too long, force-hide to prevent
        // the native view from staying permanently visible.
        const safetyTimer = setTimeout(() => {
          if (!cancelled) ensureHidden();
        }, 300);

        invoke<string>("web_session_capture_and_hide", { sessionId })
          .then((dataUrl) => {
            clearTimeout(safetyTimer);
            if (!cancelled && dataUrl && dataUrl.length > 100) {
              setFrozenScreenshot(dataUrl);
            } else if (!cancelled) {
              // Empty/invalid screenshot — native view is already hidden by backend,
              // clear any stale screenshot so user sees bg-canvas
              setFrozenScreenshot(null);
            }
          })
          .catch(() => {
            clearTimeout(safetyTimer);
            // Capture failed — ensure hidden (user sees bg-canvas)
            if (!cancelled) {
              ensureHidden();
              setFrozenScreenshot(null);
            }
          });

        return () => {
          cancelled = true;
          clearTimeout(safetyTimer);
        };
      }
    }

    return () => { cancelled = true; };
  }, [shouldBeNative, webviewReady, sessionId, syncBounds, isActive, ensureHidden]);

  // Update prevIsActiveRef after render (must be outside the effect above
  // so it captures the value from the *previous* render)
  useEffect(() => {
    prevIsActiveRef.current = isActive;
  }, [isActive]);

  // ── img onLoad callback ────────────────────────────────────────
  // Screenshot is painted in the DOM. Now safe to hide the native view
  // (which was rendering on top). This creates a seamless swap.
  const onScreenshotLoaded = useCallback(() => {
    // Only hide if we still shouldn't be native (might have flipped back)
    if (!shouldBeNativeRef.current) {
      ensureHidden();
    }
  }, [ensureHidden]);

  // ── img onError callback ───────────────────────────────────────
  // Screenshot data URL was corrupt or empty — clear it and ensure hidden.
  const onScreenshotError = useCallback(() => {
    setFrozenScreenshot(null);
    if (!shouldBeNativeRef.current) {
      ensureHidden();
    }
  }, [ensureHidden]);

  return { shouldBeNative, frozenScreenshot, onScreenshotLoaded, onScreenshotError };
}
