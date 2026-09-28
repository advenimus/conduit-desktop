import { useState } from "react";
import { invoke } from "../../../lib/electron";
import { useSessionStore } from "../../../stores/sessionStore";
import type { WebTabInfo } from "../../../stores/webTabStore";
import { CloseIcon, GlobeIcon, PlusIcon } from "../../../lib/icons";
import { IconButton, cx } from "../../ui";

interface WebSubTabBarProps {
  sessionId: string;
  tabs: WebTabInfo[];
  activeTabId: string | null;
}

export default function WebSubTabBar({ sessionId, tabs, activeTabId }: WebSubTabBarProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Only show when 2+ tabs
  if (tabs.length < 2) return null;

  const handleSwitchTab = (tabId: string) => {
    if (tabId === activeTabId) return;
    invoke("web_session_switch_tab", { sessionId, tabId }).catch(console.error);
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    try {
      const result = await invoke<{ lastTab: boolean }>("web_session_close_tab", { sessionId, tabId });
      if (result.lastTab) {
        useSessionStore.getState().closeSession(sessionId);
      }
    } catch (err) {
      console.error("[WebSubTabBar] closeTab failed:", err);
    }
  };

  const handleNewTab = async () => {
    try {
      const homeUrl = await invoke<string>("web_session_get_original_url", { sessionId });
      invoke("web_session_create_tab", { sessionId, url: homeUrl || undefined }).catch(console.error);
    } catch {
      invoke("web_session_create_tab", { sessionId }).catch(console.error);
    }
  };

  const safeHostname = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url || "New Tab";
    }
  };

  // ── Drag-to-reorder handlers ──────────────────────────────────

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      invoke("web_session_reorder_tab", {
        sessionId,
        fromIndex: dragIndex,
        toIndex: index,
      }).catch(console.error);
    }
    setDragIndex(null);
    setDropIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <div className="flex-none h-8 bg-editor border-b border-divider flex items-center gap-0.5 px-1 overflow-x-auto scrollbar-none">
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const isDragging = dragIndex === index;
        const isDropTarget = dropIndex === index && dragIndex !== null && dragIndex !== index;

        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={() => setDropIndex(null)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            onClick={() => handleSwitchTab(tab.id)}
            data-active={isActive ? "" : undefined}
            data-drop-target={isDropTarget ? "" : undefined}
            data-dragging={isDragging ? "" : undefined}
            className={cx(
              "group flex items-center gap-1.5 h-6 px-2 rounded text-label cursor-pointer min-w-0 max-w-[200px] transition-colors",
              isActive ? "bg-selected text-ink" : "text-ink-muted hover:bg-hover",
              isDragging && "opacity-50",
              // An inset bar marks the drop position without shifting the row.
              isDropTarget && "shadow-[inset_2px_0_0_var(--c-accent)]",
            )}
          >
            {/* Favicon */}
            {tab.favicon ? (
              <img
                src={tab.favicon}
                alt=""
                className="w-4 h-4 flex-shrink-0"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <GlobeIcon size={16} className="flex-shrink-0 text-ink-faint" />
            )}

            {/* Title */}
            <span className="truncate flex-1">
              {tab.title || safeHostname(tab.url)}
            </span>

            {/* Close button, shown on hover as today */}
            <IconButton
              size="sm"
              icon={CloseIcon}
              label="Close tab"
              onClick={(e) => handleCloseTab(e, tab.id)}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
        );
      })}

      {/* New tab button */}
      <IconButton icon={PlusIcon} label="New Tab" onClick={handleNewTab} />
    </div>
  );
}
