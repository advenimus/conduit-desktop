import { useState, useRef, useCallback } from "react";
import { invoke } from "../../../lib/electron";
import {
  ArrowLeftIcon, ArrowRightIcon, CheckIcon, CloseIcon, HomeIcon, KeyIcon, LoaderIcon, LockIcon, LockOpenIcon, PlusIcon, RefreshIcon, TargetIcon
} from "../../../lib/icons";

type AutofillStatus = "idle" | "filling" | "success" | "error";

interface WebBrowserToolbarProps {
  sessionId: string;
  entryId?: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isSecure: boolean;
  autofillEnabled: boolean;
  autofillStatus: AutofillStatus;
  onAutofill: () => void;
  onStartPicker: () => void;
}

export default function WebBrowserToolbar({
  sessionId,
  entryId,
  url,
  isLoading,
  canGoBack,
  canGoForward,
  isSecure,
  autofillEnabled,
  autofillStatus,
  onAutofill,
  onStartPicker,
}: WebBrowserToolbarProps) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlInput, setUrlInput] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  const [actionsExpanded, setActionsExpanded] = useState(false);

  const handleGoBack = useCallback(() => {
    invoke("web_session_go_back", { sessionId }).catch(console.error);
  }, [sessionId]);

  const handleGoForward = useCallback(() => {
    invoke("web_session_go_forward", { sessionId }).catch(console.error);
  }, [sessionId]);

  const handleRefreshOrStop = useCallback(() => {
    if (isLoading) {
      invoke("web_session_stop", { sessionId }).catch(console.error);
    } else {
      invoke("web_session_reload", { sessionId }).catch(console.error);
    }
  }, [sessionId, isLoading]);

  const handleHome = useCallback(async () => {
    try {
      const originalUrl = await invoke<string>("web_session_get_original_url", { sessionId });
      if (originalUrl) {
        invoke("web_session_navigate", { sessionId, url: originalUrl }).catch(console.error);
      }
    } catch (err) {
      console.error("[WebBrowserToolbar] Failed to navigate home:", err);
    }
  }, [sessionId]);

  const handleNewTab = useCallback(async () => {
    try {
      const homeUrl = await invoke<string>("web_session_get_original_url", { sessionId });
      invoke("web_session_create_tab", { sessionId, url: homeUrl || undefined }).catch(console.error);
    } catch {
      invoke("web_session_create_tab", { sessionId }).catch(console.error);
    }
  }, [sessionId]);

  const handleUrlSubmit = useCallback(() => {
    let finalUrl = urlInput.trim();
    if (!finalUrl) {
      setEditingUrl(false);
      return;
    }

    // Prepend https:// if no protocol
    if (!/^https?:\/\//i.test(finalUrl) && !finalUrl.startsWith("about:")) {
      finalUrl = `https://${finalUrl}`;
    }

    invoke("web_session_navigate", { sessionId, url: finalUrl }).catch(console.error);
    setEditingUrl(false);
  }, [sessionId, urlInput]);

  const handleAddressBarClick = useCallback(() => {
    setUrlInput(url);
    setEditingUrl(true);
    // Focus after state update
    setTimeout(() => inputRef.current?.select(), 0);
  }, [url]);

  // Display URL: strip protocol for display
  const displayUrl = url.replace(/^https?:\/\//, "");

  return (
    <div className="flex-none h-9 bg-panel border-b border-stroke flex items-center gap-1 px-2">
      {/* Navigation buttons */}
      <button
        onClick={handleGoBack}
        disabled={!canGoBack}
        className={`p-1.5 rounded hover:bg-raised transition-colors ${
          canGoBack ? "text-ink-muted" : "text-ink-faint opacity-40 cursor-default"
        }`}
        title="Back"
      >
        <ArrowLeftIcon size={16} />
      </button>

      <button
        onClick={handleGoForward}
        disabled={!canGoForward}
        className={`p-1.5 rounded hover:bg-raised transition-colors ${
          canGoForward ? "text-ink-muted" : "text-ink-faint opacity-40 cursor-default"
        }`}
        title="Forward"
      >
        <ArrowRightIcon size={16} />
      </button>

      <button
        onClick={handleRefreshOrStop}
        className="p-1.5 rounded hover:bg-raised transition-colors text-ink-muted"
        title={isLoading ? "Stop" : "Refresh"}
      >
        {isLoading ? (
          <CloseIcon size={16} />
        ) : (
          <RefreshIcon size={16} />
        )}
      </button>

      <button
        onClick={handleHome}
        className="p-1.5 rounded hover:bg-raised transition-colors text-ink-muted"
        title="Home"
      >
        <HomeIcon size={16} />
      </button>

      {/* Address bar */}
      <div className="flex-1 relative flex items-center min-w-0">
        <div className="absolute left-2.5 z-10 pointer-events-none">
          {isSecure ? (
            <LockIcon size={13} className="text-green-500" />
          ) : (
            <LockOpenIcon size={13} className="text-ink-faint" />
          )}
        </div>

        {editingUrl ? (
          <input
            ref={inputRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUrlSubmit();
              if (e.key === "Escape") setEditingUrl(false);
            }}
            onBlur={() => setEditingUrl(false)}
            className="w-full h-7 rounded bg-raised border border-conduit-500 text-sm text-ink px-3 pl-8 outline-none"
            autoFocus
          />
        ) : (
          <div
            onClick={handleAddressBarClick}
            className="w-full h-7 rounded bg-raised border border-stroke-dim text-sm text-ink-muted px-3 pl-8 flex items-center cursor-text truncate"
          >
            {displayUrl || "about:blank"}
          </div>
        )}
      </div>

      {/* New tab — opens session's home URL */}
      <button
        onClick={handleNewTab}
        className="p-1.5 rounded hover:bg-raised transition-colors text-ink-muted"
        title="New Tab"
      >
        <PlusIcon size={16} />
      </button>

      {/* Autofill button (only if entry) */}
      {entryId && (
        <div className="flex items-center">
          <div
            className="overflow-hidden flex items-center transition-all duration-300 ease-in-out"
            style={{
              maxWidth: actionsExpanded ? "200px" : "0px",
              opacity: actionsExpanded ? 1 : 0,
            }}
          >
            <div className="flex items-center gap-1 pr-1">
              <button
                onClick={() => {
                  setActionsExpanded(false);
                  onStartPicker();
                }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-raised hover:bg-stroke text-ink-muted whitespace-nowrap transition-colors"
                title="Pick CSS selectors"
              >
                <TargetIcon size={14} />
                Pick
              </button>
              {autofillEnabled && (
                <button
                  onClick={() => {
                    setActionsExpanded(false);
                    onAutofill();
                  }}
                  disabled={autofillStatus === "filling"}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-raised hover:bg-stroke text-ink-muted whitespace-nowrap disabled:opacity-40 transition-colors"
                  title="Populate login fields"
                >
                  <KeyIcon size={14} />
                  Fill
                </button>
              )}
            </div>
          </div>
          <button
            onClick={() => setActionsExpanded((v) => !v)}
            disabled={autofillStatus === "filling"}
            className={`p-1.5 rounded transition-colors ${
              autofillStatus === "success"
                ? "text-green-400"
                : autofillStatus === "filling"
                  ? "text-conduit-400 cursor-wait"
                  : "text-ink-muted hover:bg-raised"
            }`}
            title="Autofill"
          >
            {autofillStatus === "filling" && <LoaderIcon size={16} className="animate-spin" />}
            {autofillStatus === "success" && <CheckIcon size={16} />}
            {(autofillStatus === "idle" || autofillStatus === "error") && <KeyIcon size={16} />}
          </button>
        </div>
      )}
    </div>
  );
}
