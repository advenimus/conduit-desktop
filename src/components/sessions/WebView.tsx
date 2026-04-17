import { useEffect, useRef, useState, useCallback } from "react";
import { invoke, listen, listenSync } from "../../lib/electron";
import { useWebTabStore, type WebTabInfo } from "../../stores/webTabStore";
import { useNativeViewVisibility } from "../../hooks/useNativeViewVisibility";
import WebBrowserToolbar from "./web/WebBrowserToolbar";
import WebSubTabBar from "./web/WebSubTabBar";
import WebAutofillBar, { type PickerStep, type PickedSelectors } from "./web/WebAutofillBar";
import { AlertTriangleIcon } from "../../lib/icons";
import { toast } from "../common/Toast";
import { formatFileSize } from "../../lib/format";

interface CertError {
  url: string;
  error: string;
  issuer: string;
  subject: string;
}

type AutofillStatus = "idle" | "filling" | "success" | "error";

interface WebViewProps {
  sessionId: string;
  entryId?: string;
  isActive?: boolean;
  onClose?: () => void;
}

export default function WebView({ sessionId, entryId, isActive = true }: WebViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [certError, setCertError] = useState<CertError | null>(null);
  const webviewCreated = useRef(false);

  // Autofill state
  const [autofillEnabled, setAutofillEnabled] = useState(false);
  const [autofillStatus, setAutofillStatus] = useState<AutofillStatus>("idle");
  const autofillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Picker wizard state
  const [pickerActive, setPickerActive] = useState(false);
  const [pickerStep, setPickerStep] = useState<PickerStep>("username");
  const [pickedSelectors, setPickedSelectors] = useState<PickedSelectors>({});
  const [pickerSaving, setPickerSaving] = useState(false);
  const pickerActiveRef = useRef(false);

  // Tab state from store
  const tabState = useWebTabStore((s) => s.sessionTabs[sessionId]);
  const tabs = tabState?.tabs ?? [];
  const activeTabId = tabState?.activeTabId ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Navigation state from the active tab
  const navUrl = activeTab?.url ?? "";
  const navIsLoading = activeTab?.isLoading ?? false;
  const navCanGoBack = activeTab?.canGoBack ?? false;
  const navCanGoForward = activeTab?.canGoForward ?? false;
  const navIsSecure = activeTab?.isSecure ?? false;

  // ── Fetch initial tab list + autofill config ──────────────────

  useEffect(() => {
    invoke<{ tabs: WebTabInfo[]; activeTabId: string | null }>(
      "web_session_get_tabs",
      { sessionId }
    )
      .then(({ tabs: initialTabs, activeTabId: initialActive }) => {
        if (initialTabs.length > 0) {
          useWebTabStore.getState().setTabs(sessionId, initialTabs, initialActive);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (!entryId) return;
    invoke<{ enabled?: boolean } | null>("web_session_get_autofill_config", { entryId })
      .then((config) => {
        setAutofillEnabled(config?.enabled ?? false);
      })
      .catch(() => setAutofillEnabled(false));
  }, [entryId]);

  // ── Autofill handler ──────────────────────────────────────────

  const handleAutofill = async () => {
    if (!entryId || autofillStatus === "filling") return;
    setAutofillStatus("filling");

    if (autofillTimerRef.current) {
      clearTimeout(autofillTimerRef.current);
      autofillTimerRef.current = null;
    }

    try {
      const result = await invoke<{ success: boolean; phase: string; fieldsFilled: string[]; error?: string }>(
        "web_session_autofill",
        { sessionId, entryId }
      );
      if (result.success) {
        setAutofillStatus("success");
        autofillTimerRef.current = setTimeout(() => setAutofillStatus("idle"), 3000);
      } else {
        setAutofillStatus("error");
        console.warn("[autofill] error:", result.error ?? "Autofill failed");
        autofillTimerRef.current = setTimeout(() => setAutofillStatus("idle"), 5000);
      }
    } catch (err) {
      setAutofillStatus("error");
      console.warn("[autofill] error:", String(err));
      autofillTimerRef.current = setTimeout(() => setAutofillStatus("idle"), 5000);
    }
  };

  // ── Picker wizard logic ───────────────────────────────────────

  const cancelPicker = useCallback(async () => {
    pickerActiveRef.current = false;
    setPickerActive(false);
    setPickerStep("username");
    setPickedSelectors({});
    try {
      await invoke("web_session_cancel_picker", { sessionId });
    } catch {
      // safe to ignore
    }
  }, [sessionId]);

  const startPickerWizard = useCallback(() => {
    if (!entryId || pickerActive) return;
    setPickerActive(true);
    setPickerStep("username");
    setPickedSelectors({});
    pickerActiveRef.current = true;
  }, [entryId, pickerActive]);

  const runPickerStep = useCallback(
    async (step: Exclude<PickerStep, "review">) => {
      if (!pickerActiveRef.current) return;

      try {
        const result = await invoke<{
          selector: string;
          tagName: string;
          type: string | null;
          name: string | null;
          placeholder: string | null;
          id: string | null;
        } | null>("web_session_start_picker", { sessionId });

        if (!pickerActiveRef.current) return;

        if (result) {
          setPickedSelectors((prev) => {
            const key =
              step === "username"
                ? "usernameSelector"
                : step === "password"
                  ? "passwordSelector"
                  : "submitSelector";
            return { ...prev, [key]: result.selector };
          });
        }

        advanceStep(step);
      } catch {
        if (pickerActiveRef.current) cancelPicker();
      }
    },
    [sessionId, cancelPicker]
  );

  const advanceStep = (currentStep: Exclude<PickerStep, "review">) => {
    if (!pickerActiveRef.current) return;
    const next: Record<Exclude<PickerStep, "review">, PickerStep> = {
      username: "password",
      password: "submit",
      submit: "review",
    };
    setPickerStep(next[currentStep]);
  };

  const skipStep = useCallback(async () => {
    if (!pickerActiveRef.current || pickerStep === "review") return;
    try {
      await invoke("web_session_cancel_picker", { sessionId });
    } catch {
      // ignore
    }
    advanceStep(pickerStep as Exclude<PickerStep, "review">);
  }, [pickerStep, sessionId]);

  const finishPicker = useCallback(async () => {
    if (!pickerActiveRef.current || pickerStep === "review") return;
    try {
      await invoke("web_session_cancel_picker", { sessionId });
    } catch {
      // ignore
    }
    setPickerStep("review");
  }, [pickerStep, sessionId]);

  // Start picking when step changes (except review)
  useEffect(() => {
    if (!pickerActive || pickerStep === "review") return;
    runPickerStep(pickerStep);
  }, [pickerActive, pickerStep, runPickerStep]);

  const savePickedSelectors = async () => {
    if (!entryId || pickerSaving) return;
    setPickerSaving(true);
    try {
      await invoke("web_session_save_autofill_selectors", {
        entryId,
        selectors: pickedSelectors,
      });
      const config = await invoke<{ enabled?: boolean } | null>(
        "web_session_get_autofill_config",
        { entryId }
      );
      setAutofillEnabled(config?.enabled ?? true);
      setPickerActive(false);
      setPickerStep("username");
      setPickedSelectors({});
      pickerActiveRef.current = false;
    } catch (err) {
      console.error("[picker] Failed to save selectors:", err);
    } finally {
      setPickerSaving(false);
    }
  };

  // Cleanup picker on unmount
  useEffect(() => {
    return () => {
      if (pickerActiveRef.current) {
        invoke("web_session_cancel_picker", { sessionId }).catch(() => {});
      }
    };
  }, [sessionId]);

  // ── Bounds sync + webview lifecycle ────────────────────────────

  const lastBoundsRef = useRef("");

  const syncBounds = useCallback(async () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
    if (key === lastBoundsRef.current) return;
    lastBoundsRef.current = key;

    try {
      await invoke("web_session_update_position", { sessionId, ...bounds });
    } catch (err) {
      console.error("[WebView] Failed to sync bounds:", err);
    }
  }, [sessionId]);

  const createWebview = useCallback(async () => {
    if (!containerRef.current || webviewCreated.current) return;

    // Wait a frame for layout to settle
    await new Promise((r) => requestAnimationFrame(r));
    if (!containerRef.current || webviewCreated.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    try {
      await invoke("web_session_create_webview", {
        sessionId,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      webviewCreated.current = true;
      setIsReady(true);
      setError(null);

      // Fetch initial tab list after webview creation
      const result = await invoke<{ tabs: WebTabInfo[]; activeTabId: string | null }>(
        "web_session_get_tabs",
        { sessionId }
      );
      if (result.tabs.length > 0) {
        useWebTabStore.getState().setTabs(sessionId, result.tabs, result.activeTabId);
      }
    } catch (err) {
      console.error("[WebView] Failed to create webview:", err);
      if (!webviewCreated.current) setError(String(err));
    }
  }, [sessionId]);

  // Create webview on mount, observe resizes
  useEffect(() => {
    createWebview();

    const observer = new ResizeObserver(() => {
      if (webviewCreated.current) {
        lastBoundsRef.current = "";
        syncBounds();
      } else {
        // Retry creation — container may have had 0 dimensions on initial mount
        // (e.g. pane restructuring during split view collapse)
        createWebview();
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [createWebview, syncBounds]);

  // ── Native view visibility (single source of truth) ──────────
  // The hook derives ONE boolean from all conditions (isActive, overlay,
  // sidebar, drag). When it flips, it handles capture/show/hide transitions.
  const { shouldBeNative, frozenScreenshot, onScreenshotLoaded, onScreenshotError } = useNativeViewVisibility({
    sessionId,
    isActive,
    webviewReady: isReady,
    syncBounds,
  });

  // Re-sync bounds when layout changes (only when native view is live)
  useEffect(() => {
    const handleLayoutChanged = () => {
      if (!webviewCreated.current || !shouldBeNative) return;
      lastBoundsRef.current = "";
      syncBounds();
    };
    document.addEventListener("conduit:layout-changed", handleLayoutChanged);
    return () => document.removeEventListener("conduit:layout-changed", handleLayoutChanged);
  }, [shouldBeNative, syncBounds]);

  // Re-sync bounds on window resize (only when native view is live)
  useEffect(() => {
    const unlisten = window.electron.on("window-resized", () => {
      if (webviewCreated.current && shouldBeNative) {
        lastBoundsRef.current = "";
        syncBounds();
      }
    });
    return () => { unlisten(); };
  }, [shouldBeNative, syncBounds]);

  // ── Event listeners from main process ─────────────────────────

  // Navigation state changes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{
      sessionId: string;
      tabId: string;
      url: string;
      isLoading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }>("web:nav-state-changed", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      useWebTabStore.getState().updateTab(sessionId, event.payload.tabId, {
        url: event.payload.url,
        isLoading: event.payload.isLoading,
        canGoBack: event.payload.canGoBack,
        canGoForward: event.payload.canGoForward,
        isSecure: event.payload.url.startsWith("https://"),
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // Tab title changes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; tabId: string; title: string }>(
      "web:tab-title-changed",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        useWebTabStore.getState().updateTab(sessionId, event.payload.tabId, {
          title: event.payload.title,
        });
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // Tab favicon changes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; tabId: string; favicon: string | null }>(
      "web:tab-favicon-changed",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        useWebTabStore.getState().updateTab(sessionId, event.payload.tabId, {
          favicon: event.payload.favicon,
        });
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // Tab list changes (tab created/closed)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; tabs: WebTabInfo[]; activeTabId: string | null }>(
      "web:tab-list-changed",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        useWebTabStore.getState().setTabs(
          sessionId,
          event.payload.tabs,
          event.payload.activeTabId
        );
        // Bounds may need updating if sub-tab bar appeared/disappeared
        lastBoundsRef.current = "";
        requestAnimationFrame(() => syncBounds());
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId, syncBounds]);

  // Tab created (window.open)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; tabId: string; url: string }>(
      "web:tab-created",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        // The tab-list-changed event handles the full update;
        // this event just triggers a bounds re-sync for sub-tab bar appearance
        lastBoundsRef.current = "";
        requestAnimationFrame(() => syncBounds());
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId, syncBounds]);

  // Certificate errors
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; url: string; error: string; issuer: string; subject: string }>(
      "web:cert-error",
      (event) => {
        if (event.payload.sessionId === sessionId) {
          setCertError({
            url: event.payload.url,
            error: event.payload.error,
            issuer: event.payload.issuer,
            subject: event.payload.subject,
          });
          invoke("web_session_hide", { sessionId }).catch(() => {});
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // Auto-autofill results
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; success: boolean; fieldsFilled: string[]; error?: string }>(
      "web:autofill-result",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        if (event.payload.success) {
          setAutofillStatus("success");
          autofillTimerRef.current = setTimeout(() => setAutofillStatus("idle"), 3000);
        } else if (event.payload.error) {
          setAutofillStatus("error");
          console.warn("[autofill] auto-result error:", event.payload.error);
          autofillTimerRef.current = setTimeout(() => setAutofillStatus("idle"), 5000);
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  // ── Download handling ─────────────────────────────────────────

  // Track download toast IDs: downloadId → { promptToastId, progressToastId, action }
  const downloadMapRef = useRef(new Map<string, {
    promptToastId: string;
    progressToastId: string | null;
    action: "open" | "save" | null;
  }>());
  // Speed calculation refs (shared across downloads for simplicity)
  const dlLastBytesRef = useRef(0);
  const dlLastTimeRef = useRef(0);
  const dlLastSpeedRef = useRef<string | undefined>(undefined);

  // Download prompt — show toast with Open / Save As / Cancel
  // Uses listenSync to avoid StrictMode double-mount creating duplicate toasts
  useEffect(() => {
    const unlisten = listenSync<{
      downloadId: string;
      sessionId: string;
      filename: string;
      totalBytes: number;
      mimeType: string;
    }>("web:download-prompt", (event) => {
      if (event.payload.sessionId !== sessionId) return;

      const { downloadId, filename, totalBytes } = event.payload;
      const sizeStr = totalBytes > 0 ? formatFileSize(totalBytes) : "Unknown size";

      const promptToastId = toast.info(`Download: ${filename}`, {
        message: sizeStr,
        persistent: true,
        dismissOnAction: true,
        actions: [
          {
            label: "Open",
            variant: "primary",
            onClick: () => {
              invoke("web_download_respond", { downloadId, action: "open" }).catch((err) => {
                toast.error("Download failed", String(err));
              });
              const entry = downloadMapRef.current.get(downloadId);
              if (entry) entry.action = "open";
              showDownloadProgress(downloadId, filename, totalBytes);
            },
          },
          {
            label: "Save As",
            onClick: () => {
              invoke("web_download_respond", { downloadId, action: "save_as" }).catch((err) => {
                toast.error("Download failed", String(err));
              });
              const entry = downloadMapRef.current.get(downloadId);
              if (entry) entry.action = "save";
              showDownloadProgress(downloadId, filename, totalBytes);
            },
          },
          {
            label: "Cancel",
            onClick: () => {
              invoke("web_download_respond", { downloadId, action: "cancel" }).catch(() => {});
              downloadMapRef.current.delete(downloadId);
            },
          },
        ],
      });

      downloadMapRef.current.set(downloadId, { promptToastId, progressToastId: null, action: null });
    });
    return () => { unlisten(); };
  }, [sessionId]);

  const showDownloadProgress = useCallback((downloadId: string, filename: string, totalBytes: number) => {
    // Reset speed tracking for this download
    dlLastBytesRef.current = 0;
    dlLastTimeRef.current = 0;
    dlLastSpeedRef.current = undefined;

    const progressToastId = toast.info(`Downloading: ${filename}`, {
      persistent: true,
      progress: {
        percent: 0,
        leftLabel: "Starting...",
        rightLabel: totalBytes > 0 ? `0 / ${formatFileSize(totalBytes)}` : "",
      },
    });

    const entry = downloadMapRef.current.get(downloadId);
    if (entry) {
      entry.progressToastId = progressToastId;
    }
  }, []);

  // Download progress — update the progress toast
  useEffect(() => {
    const unlisten = listenSync<{ downloadId: string; receivedBytes: number; totalBytes: number }>(
      "web:download-progress",
      (event) => {
        const entry = downloadMapRef.current.get(event.payload.downloadId);
        if (!entry?.progressToastId) return;

        const { receivedBytes, totalBytes } = event.payload;
        const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;

        // Calculate speed (throttled to every 500ms)
        const now = Date.now();
        const elapsed = now - dlLastTimeRef.current;
        if (elapsed > 500 && dlLastTimeRef.current > 0) {
          const bytesDelta = receivedBytes - dlLastBytesRef.current;
          if (bytesDelta > 0) {
            const bytesPerSec = (bytesDelta / elapsed) * 1000;
            dlLastSpeedRef.current = `${formatFileSize(bytesPerSec)}/s`;
          }
          dlLastBytesRef.current = receivedBytes;
          dlLastTimeRef.current = now;
        } else if (dlLastTimeRef.current === 0) {
          dlLastBytesRef.current = receivedBytes;
          dlLastTimeRef.current = now;
        }

        toast.update(entry.progressToastId, {
          progress: {
            percent,
            leftLabel: totalBytes > 0 ? `${percent}%` : "Downloading...",
            rightLabel: totalBytes > 0
              ? `${formatFileSize(receivedBytes)} / ${formatFileSize(totalBytes)}`
              : formatFileSize(receivedBytes),
            speed: dlLastSpeedRef.current,
          },
        });
      }
    );
    return () => { unlisten(); };
  }, []);

  // Download completion — dismiss progress toast, show result
  useEffect(() => {
    const unlisten = listenSync<{ downloadId: string; state: string; savePath?: string; action?: string }>(
      "web:download-done",
      (event) => {
        const entry = downloadMapRef.current.get(event.payload.downloadId);
        // Only handle downloads that belong to this WebView instance
        if (!entry) return;

        if (entry.progressToastId) {
          toast.dismiss(entry.progressToastId);
        }

        downloadMapRef.current.delete(event.payload.downloadId);

        if (event.payload.state === "completed") {
          const action = event.payload.action ?? entry.action;
          if (action === "open") {
            // Silent — file opens automatically via backend, no toast needed
          } else if (action === "save") {
            const displayName = event.payload.savePath?.split(/[\\/]/).pop() ?? "File";
            toast.success("File saved", displayName);
          }
        } else if (event.payload.state === "cancelled") {
          // Silent — user cancelled intentionally
        } else {
          toast.error("Download failed", event.payload.state ?? "Unknown error");
        }
      }
    );
    return () => { unlisten(); };
  }, []);

  // Cleanup download toasts on unmount
  useEffect(() => {
    return () => {
      for (const [, entry] of downloadMapRef.current) {
        if (entry.promptToastId) toast.dismiss(entry.promptToastId);
        if (entry.progressToastId) toast.dismiss(entry.progressToastId);
      }
      downloadMapRef.current.clear();
    };
  }, []);

  const handleAcceptCert = async () => {
    setCertError(null);
    await invoke("web_session_accept_cert", { sessionId });
    // The hook will automatically show the native view if shouldBeNative is true
  };

  // Hide native view on unmount
  useEffect(() => {
    return () => {
      invoke("web_session_hide", { sessionId }).catch(() => {});
    };
  }, [sessionId]);

  // Clean up tab store on unmount
  useEffect(() => {
    return () => {
      useWebTabStore.getState().clearSession(sessionId);
    };
  }, [sessionId]);

  // Cleanup autofill timer
  useEffect(() => {
    return () => {
      if (autofillTimerRef.current) clearTimeout(autofillTimerRef.current);
    };
  }, []);

  return (
    <div className="h-full w-full flex flex-col">
      {/* Browser toolbar (always visible) */}
      <WebBrowserToolbar
        sessionId={sessionId}
        entryId={entryId}
        url={navUrl}
        isLoading={navIsLoading}
        canGoBack={navCanGoBack}
        canGoForward={navCanGoForward}
        isSecure={navIsSecure}
        autofillEnabled={autofillEnabled}
        autofillStatus={autofillStatus}
        onAutofill={handleAutofill}
        onStartPicker={startPickerWizard}
      />

      {/* Sub-tab bar (only when 2+ tabs) */}
      <WebSubTabBar
        sessionId={sessionId}
        tabs={tabs}
        activeTabId={activeTabId}
      />

      {/* Autofill picker bar (conditional) */}
      {pickerActive && (
        <WebAutofillBar
          pickerStep={pickerStep}
          pickedSelectors={pickedSelectors}
          pickerSaving={pickerSaving}
          onSkip={skipStep}
          onFinish={finishPicker}
          onSave={savePickedSelectors}
          onCancel={cancelPicker}
        />
      )}

      {/* WebContentsView container */}
      <div ref={containerRef} className="flex-1 bg-canvas relative">
        {/* Frozen screenshot — shown whenever native view is not live */}
        {frozenScreenshot && (
          <img
            src={frozenScreenshot}
            alt=""
            className="absolute inset-0 w-full h-full object-contain"
            draggable={false}
            style={{ pointerEvents: "none", background: "#000" }}
            onLoad={onScreenshotLoaded}
            onError={onScreenshotError}
          />
        )}
        {!isReady && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-ink-muted">Loading web session...</div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-red-400 mb-2">Failed to load web session</div>
              <div className="text-ink-faint text-sm max-w-md">{error}</div>
              <button
                onClick={() => {
                  setError(null);
                  webviewCreated.current = false;
                  createWebview();
                }}
                className="mt-4 px-4 py-2 bg-raised hover:bg-raised rounded text-sm"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {certError && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas">
            <div className="max-w-lg text-center px-8">
              <AlertTriangleIcon size={48} className="text-yellow-500 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-ink mb-2">
                Your connection is not private
              </h2>
              <p className="text-sm text-ink-muted mb-4">
                The certificate for{" "}
                <span className="text-ink font-mono">{certError.url}</span> is not trusted.
              </p>
              <div className="bg-panel border border-stroke rounded p-3 text-left text-xs text-ink-muted mb-6 space-y-1">
                <div>
                  <span className="text-ink-faint">Error:</span> {certError.error}
                </div>
                <div>
                  <span className="text-ink-faint">Issuer:</span> {certError.issuer}
                </div>
                <div>
                  <span className="text-ink-faint">Subject:</span> {certError.subject}
                </div>
              </div>
              <p className="text-xs text-ink-faint mb-6">
                This may indicate a self-signed certificate, an expired certificate, or a potential
                security risk. Only proceed if you trust this server.
              </p>
              <div className="flex justify-center gap-3">
                <button
                  onClick={handleAcceptCert}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-sm"
                >
                  Proceed Anyway
                </button>
              </div>
              <p className="text-xs text-ink-faint mt-3">
                To always skip this warning, enable "Ignore certificate errors" in the entry
                settings.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
