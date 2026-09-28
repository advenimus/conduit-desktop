import { useState, useRef, useCallback } from "react";
import { invoke } from "../../../lib/electron";
import {
  ArrowLeftIcon, ArrowRightIcon, CheckIcon, CloseIcon, HomeIcon, KeyIcon, LoaderIcon, LockIcon, LockOpenIcon, PlusIcon, RefreshIcon, TargetIcon
} from "../../../lib/icons";
import { Button, IconButton } from "../../ui";

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
    <div className="flex-none h-9 bg-editor border-b border-divider flex items-center gap-1 px-2">
      <IconButton icon={ArrowLeftIcon} label="Back" onClick={handleGoBack} disabled={!canGoBack} />
      <IconButton icon={ArrowRightIcon} label="Forward" onClick={handleGoForward} disabled={!canGoForward} />
      <IconButton
        icon={isLoading ? CloseIcon : RefreshIcon}
        label={isLoading ? "Stop" : "Refresh"}
        onClick={handleRefreshOrStop}
      />
      <IconButton icon={HomeIcon} label="Home" onClick={handleHome} />

      {/* Address bar */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 h-control rounded border border-input-border bg-input px-2 focus-within:outline focus-within:outline-1 focus-within:outline-(--c-focus) focus-within:-outline-offset-1">
        {isSecure ? (
          <LockIcon size={16} className="shrink-0 text-ink-muted" />
        ) : (
          <LockOpenIcon size={16} className="shrink-0 text-ink-muted" />
        )}

        {editingUrl ? (
          <input
            ref={inputRef}
            type="text"
            data-bare=""
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUrlSubmit();
              if (e.key === "Escape") setEditingUrl(false);
            }}
            onBlur={() => setEditingUrl(false)}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-(--c-input-fg) outline-hidden"
            autoFocus
          />
        ) : (
          <div
            onClick={handleAddressBarClick}
            className="min-w-0 flex-1 truncate text-body text-ink-muted cursor-text"
          >
            {displayUrl || "about:blank"}
          </div>
        )}
      </div>

      {/* New tab — opens session's home URL */}
      <IconButton icon={PlusIcon} label="New Tab" onClick={handleNewTab} />

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
              <Button
                size="sm"
                icon={TargetIcon}
                onClick={() => {
                  setActionsExpanded(false);
                  onStartPicker();
                }}
                title="Pick CSS selectors"
              >
                Pick
              </Button>
              {autofillEnabled && (
                <Button
                  size="sm"
                  icon={KeyIcon}
                  onClick={() => {
                    setActionsExpanded(false);
                    onAutofill();
                  }}
                  disabled={autofillStatus === "filling"}
                  title="Populate login fields"
                >
                  Fill
                </Button>
              )}
            </div>
          </div>
          <AutofillToggle status={autofillStatus} onClick={() => setActionsExpanded((v) => !v)} />
        </div>
      )}
    </div>
  );
}

function AutofillToggle({ status, onClick }: { status: AutofillStatus; onClick: () => void }) {
  if (status === "filling") {
    return (
      <IconButton
        icon={LoaderIcon}
        label="Autofill"
        tone="inherit"
        disabled
        className="text-link cursor-wait [&_svg]:animate-spin motion-reduce:[&_svg]:animate-none"
        onClick={onClick}
      />
    );
  }
  if (status === "success") {
    return <IconButton icon={CheckIcon} label="Autofill" tone="inherit" className="text-success" onClick={onClick} />;
  }
  return <IconButton icon={KeyIcon} label="Autofill" onClick={onClick} />;
}
