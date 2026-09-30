import { useState, useRef, useEffect } from "react";
import {
  CircleFilledIcon,
  TerminalIcon,
  DesktopIcon,
  GlobeIcon,
  FileTextIcon,
  PlayerPlayIcon,
  InfoCircleIcon,
  HomeIcon,
  MenuIcon,
} from "../../lib/icons";
import { useSessionStore, type Session, type SessionType } from "../../stores/sessionStore";
import { useLayoutStore, findLeaf } from "../../stores/layoutStore";
import { useEntryStore } from "../../stores/entryStore";
import { useSidebarStore, selectIsDockedOpen } from "../../stores/sidebarStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import { showContextMenu, type PopupMenuItem } from "../../utils/contextMenu";
import { invoke } from "../../lib/electron";
import { useTierStore } from "../../stores/tierStore";
import { useDragContext } from "./DragContext";
import { toast } from "../common/Toast";
import { openDashboardForEntry } from "../../lib/openDashboard";
import { dashboardViewOf, isHomeSession } from "../../lib/dashboardSessions";
import { AI_HARNESSES } from "../../lib/ai-harnesses";
import { IconButton, cx } from "../ui";
import type { EntryMeta } from "../../types/entry";

const typeIcons: Record<SessionType, React.ReactNode> = {
  local_shell: <TerminalIcon size={16} />,
  ssh: <TerminalIcon size={16} />,
  rdp: <DesktopIcon size={16} />,
  vnc: <DesktopIcon size={16} />,
  web: <GlobeIcon size={16} />,
  document: <FileTextIcon size={16} />,
  command: <PlayerPlayIcon size={16} />,
  dashboard: <InfoCircleIcon size={16} />,
};

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
const HOME_TAB_TOOLTIP = IS_MAC ? "Home (Cmd+Shift+H)" : "Home (Ctrl+Shift+H)";

// Chromium reports line-based wheel deltas for some mice; a line is about one row of text.
const WHEEL_LINE_PX = 16;

interface PaneTabBarProps {
  paneId: string;
  isFocused: boolean;
  rightSlot?: React.ReactNode;
}

function newTabMenuItems(cliAgentsEnabled: boolean): PopupMenuItem[] {
  return [
    { id: "quick_connect", label: "Quick Connect", icon: "link" },
    { id: "sep0", label: "", type: "separator" },
    { id: "shell_header", label: "Local Shell", type: "header" },
    { id: "home", label: "Home Directory", icon: "home" },
    ...(cliAgentsEnabled
      ? [
          { id: "sep1", label: "", type: "separator" as const },
          { id: "agent_header", label: "Agent Directory", type: "header" as const },
          ...AI_HARNESSES.map((h) => ({ id: `agent_${h.id}`, label: h.name, icon: "terminal" as const })),
        ]
      : []),
    { id: "sep2", label: "", type: "separator" },
    { id: "browse", label: "Browse...", icon: "folder" },
  ];
}

function tabMenuItems(session: Session | undefined, entry: EntryMeta | undefined): PopupMenuItem[] {
  const entryId = session?.entryId;
  const items: PopupMenuItem[] = [{ id: "rename", label: "Rename", icon: "textCursor" }];
  if (entryId && session?.type !== "dashboard" && session?.type !== "document") {
    const isReconnecting = session?.metadata?.reconnecting === true;
    items.push({ id: "reconnect", label: isReconnecting ? "Reconnecting..." : "Reconnect", icon: "refresh" });
  }
  if (entryId && session?.type !== "dashboard") {
    items.push({ id: "view_info", label: "View Info", icon: "infoCircle" });
  }
  if (session?.type === "rdp" && session?.status === "connected") {
    items.push({ id: "send_cad", label: "Send Ctrl+Alt+Delete", icon: "keyboard" });
  }
  if (entry?.username || entry?.credential_id || entryId) {
    items.push({ id: "sep1", label: "", type: "separator" });
  }
  if (entry?.username || entry?.credential_id) {
    items.push({ id: "copy_username", label: "Copy Username", icon: "user" });
  }
  if (entryId) {
    items.push({ id: "copy_password", label: "Copy Password", icon: "key" });
  }
  items.push(
    { id: "sep2", label: "", type: "separator" },
    { id: "split_right", label: "Split Right", icon: "splitHorizontal" },
    { id: "split_down", label: "Split Down", icon: "splitVertical" },
    { id: "sep3", label: "", type: "separator" },
    { id: "close", label: "Close Session", variant: "danger", icon: "close" },
  );
  return items;
}

async function copyCredentialField(entryId: string, field: "username" | "password"): Promise<void> {
  const cred = await useEntryStore.getState().resolveCredential(entryId);
  const value = cred?.[field];
  if (!value) {
    toast.error(field === "username" ? "No username available" : "No password available");
    return;
  }
  await navigator.clipboard.writeText(value);
  toast.success(field === "username" ? "Username copied" : "Password copied");
}

async function openLocalShell(choice: string): Promise<void> {
  if (choice === "home") {
    await useSessionStore.getState().createLocalShell();
    return;
  }
  if (choice === "browse") {
    const folder = await invoke<string | null>("dialog_select_folder", { title: "Select Working Directory" });
    if (folder) await useSessionStore.getState().createLocalShell(undefined, folder);
    return;
  }
  const harness = AI_HARNESSES.find((h) => `agent_${h.id}` === choice);
  if (harness) {
    const dir = await invoke<string>("get_agent_working_dir", { engineType: harness.id });
    await useSessionStore.getState().createLocalShell(undefined, dir);
  }
}

export default function PaneTabBar({ paneId, isFocused: _isFocused, rightSlot }: PaneTabBarProps) {
  const paneSessionIds = useLayoutStore((s) => {
    const pane = findLeaf(s.root, paneId);
    return pane?.sessionIds ?? [];
  });
  const paneActiveSessionId = useLayoutStore((s) => {
    const pane = findLeaf(s.root, paneId);
    return pane?.activeSessionId ?? null;
  });

  const sessions = useSessionStore((s) => s.sessions);
  const paneSessions = paneSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as typeof sessions;

  const { startDrag, endDrag } = useDragContext();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Only a row whose tabs have all shrunk to their floor scrolls; keep the newly active tab in view.
  useEffect(() => {
    if (!paneActiveSessionId) return;
    const tab = tabsRef.current?.querySelector<HTMLElement>(`[data-cv-tab="${CSS.escape(paneActiveSessionId)}"]`);
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [paneActiveSessionId]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaX !== 0 || e.deltaY === 0) return;
    const row = e.currentTarget;
    row.scrollLeft += e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
  };

  const handleNewShell = async (e: React.MouseEvent) => {
    // Focus this pane first so new session goes here
    useLayoutStore.getState().setFocusedPane(paneId);

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items = newTabMenuItems(useTierStore.getState().cliAgentsEnabled);
    const selected = await showContextMenu(rect.right, rect.bottom, items, { anchorRight: true });
    if (!selected) return;

    if (selected === "quick_connect") {
      document.dispatchEvent(new CustomEvent("conduit:quick-connect"));
      return;
    }

    try {
      await openLocalShell(selected);
    } catch (error) {
      console.error("Failed to create local shell:", error);
    }
  };

  const handleCloseTab = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    await useSessionStore.getState().closeSession(sessionId);
  };

  const handleTabClick = (sessionId: string) => {
    useLayoutStore.getState().setFocusedPane(paneId);
    useLayoutStore.getState().setActiveSessionInPane(paneId, sessionId);
  };

  const runTabMenuAction = async (selected: string, session: Session) => {
    const entryId = session.entryId;
    switch (selected) {
      case "rename":
        setRenamingId(session.id);
        setRenameValue(session.title);
        break;
      case "reconnect":
        if (!session.metadata?.reconnecting) useEntryStore.getState().reconnectSession(session.id);
        break;
      case "copy_username":
        if (entryId) await copyCredentialField(entryId, "username");
        break;
      case "copy_password":
        if (entryId) await copyCredentialField(entryId, "password");
        break;
      case "send_cad":
        await invoke("rdp_send_key", { sessionId: session.id, key: "Delete", modifiers: ["ctrl", "alt"] });
        break;
      case "view_info":
        if (entryId) openDashboardForEntry(entryId);
        break;
      case "split_right":
        useLayoutStore.getState().splitPane(paneId, "horizontal", session.id);
        break;
      case "split_down":
        useLayoutStore.getState().splitPane(paneId, "vertical", session.id);
        break;
      case "close":
        useSessionStore.getState().closeSession(session.id);
        break;
    }
  };

  const handleContextMenu = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (isHomeSession(sessionId)) return;

    const session = sessions.find((s) => s.id === sessionId);
    const entry = session?.entryId
      ? useEntryStore.getState().entries.find((en) => en.id === session.entryId)
      : undefined;

    const selected = await showContextMenu(e.clientX, e.clientY, tabMenuItems(session, entry));
    if (!selected || !session) return;
    try {
      await runTabMenuAction(selected, session);
    } catch (error) {
      console.error(`[PaneTabBar] Tab menu action "${selected}" failed:`, error);
      toast.error("That action failed");
    }
  };

  const commitRename = (sessionId: string) => {
    const trimmed = renameValue.trim();
    const session = sessions.find((s) => s.id === sessionId);
    if (trimmed && session && trimmed !== session.title) {
      useSessionStore.getState().updateSessionTitle(sessionId, trimmed);
    }
    setRenamingId(null);
  };

  const handleDragStart = (e: React.DragEvent, sessionId: string, index: number) => {
    console.debug('[PaneTabBar] dragstart', { sessionId: sessionId.slice(0, 8), index });
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/conduit-session", sessionId);
    startDrag(sessionId, paneId);
  };

  // Nothing lands before Home: a drop on the Home tab means the slot right after it.
  const dropSlot = (index: number) => (isHomeSession(paneSessions[index]?.id) ? index + 1 : index);

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex(dropSlot(index));
  };

  const handleDrop = (e: React.DragEvent, tabIndex: number) => {
    e.preventDefault();
    const index = dropSlot(tabIndex);
    console.debug('[PaneTabBar] drop', { index, dragIndex });
    const sessionId = e.dataTransfer.getData("application/conduit-session");

    if (sessionId) {
      const layoutState = useLayoutStore.getState();
      const sourcePaneSessionIds = findLeaf(layoutState.root, paneId)?.sessionIds ?? [];
      if (!sourcePaneSessionIds.includes(sessionId)) {
        // Cross-pane drop onto tab bar → move to this pane (may collapse source)
        layoutState.moveSessionToPane(sessionId, paneId);
        // Clear drag state immediately — source element may be destroyed by pane collapse
        endDrag();
      } else if (dragIndex !== null && dragIndex !== index) {
        layoutState.reorderSessionInPane(paneId, dragIndex, index);
      }
    }

    setDragIndex(null);
    setDropIndex(null);
  };

  const handleDragEnd = () => {
    console.debug('[PaneTabBar] dragend');
    setDragIndex(null);
    setDropIndex(null);
    endDrag();
  };

  // Drop on empty tab bar area (not on a specific tab)
  const handleTabBarDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleTabBarDrop = (e: React.DragEvent) => {
    // Only handle if not already handled by a tab's onDrop
    if (e.defaultPrevented) return;
    e.preventDefault();
    const sessionId = e.dataTransfer.getData("application/conduit-session");
    if (!sessionId) return;

    const layoutState = useLayoutStore.getState();
    const thisPaneSessionIds = findLeaf(layoutState.root, paneId)?.sessionIds ?? [];
    if (!thisPaneSessionIds.includes(sessionId)) {
      // Cross-pane drop onto tab bar → move to this pane (collapses source if empty)
      layoutState.moveSessionToPane(sessionId, paneId);
      endDrag();
    }
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <div data-tabbar className="cv-tabstrip">
      <SidebarToggle />

      <div
        ref={tabsRef}
        className="cv-tabs"
        onWheel={handleWheel}
        onDragOver={handleTabBarDragOver}
        onDrop={handleTabBarDrop}
        onDragLeave={() => setDropIndex(null)}
      >
        {paneSessions.map((session, index) => {
          const isHome = isHomeSession(session.id);
          return (
            <div
              key={session.id}
              data-cv-tab={session.id}
              data-cv-home-tab={isHome ? "" : undefined}
              title={isHome ? HOME_TAB_TOOLTIP : undefined}
              data-active={paneActiveSessionId === session.id ? "" : undefined}
              data-drop-target={dragIndex !== null && dropIndex === index && dragIndex !== index ? "" : undefined}
              data-dragging={dragIndex === index ? "" : undefined}
              className={cx("cv-tab", isHome && "pr-2")}
              draggable={!isHome && renamingId !== session.id}
              onDragStart={(e) => handleDragStart(e, session.id, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={() => setDropIndex(null)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => handleTabClick(session.id)}
              onContextMenu={(e) => handleContextMenu(e, session.id)}
            >
              <span className="cv-tab-fill" />
              <TabIcon session={session} />

              {renamingId === session.id ? (
                <input
                  ref={renameInputRef}
                  className="cv-tab-rename h-5 rounded-xs border border-focus bg-input px-1 text-body text-ink"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(session.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => commitRename(session.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="cv-tab-label">{session.title}</span>
              )}

              {!isHome && <StatusDot session={session} />}

              {!isHome && (
                <IconButton
                  size="sm"
                  tone="inherit"
                  icon="close"
                  label={`Close ${session.title}`}
                  className="cv-tab-close"
                  onClick={(e) => handleCloseTab(e, session.id)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="cv-tabstrip-slot">
        <IconButton
          icon="plus"
          label="New Local Shell"
          data-cv-new-tab=""
          className="mx-1"
          onClick={(e) => handleNewShell(e)}
        />
        {rightSlot}
      </div>
    </div>
  );
}

/** The hamburger: gone while the side bar is docked open, a transparent spacer while it floats open. */
function SidebarToggle() {
  const sidebarActive = useSidebarStore((s) => s.isExpanded);
  const sidebarDockedOpen = useSidebarStore(selectIsDockedOpen);
  const expandSidebar = useSidebarStore((s) => s.expand);

  if (sidebarDockedOpen) return null;

  return (
    <div className="cv-tabstrip-slot">
      <button
        type="button"
        data-cv-sidebar-toggle=""
        aria-expanded={sidebarActive}
        onClick={() => {
          if (sidebarActive) {
            document.dispatchEvent(new CustomEvent("conduit:animated-collapse"));
          } else {
            expandSidebar();
          }
        }}
        className={cx("group flex w-11 self-stretch items-center justify-center", sidebarActive && "cursor-default")}
        title={sidebarActive ? "Close sidebar (Ctrl+B)" : "Open sidebar (Ctrl+B)"}
      >
        <span
          className={cx(
            "flex size-toolbar items-center justify-center rounded transition-[color,background-color,opacity] duration-100",
            sidebarActive
              ? "opacity-0"
              : "text-ink-muted group-hover:bg-toolbar-hover group-hover:text-ink",
          )}
        >
          <MenuIcon size={16} />
        </span>
      </button>
    </div>
  );
}

function statusTitle(session: Session): string {
  if (session.status === "disconnected" && session.error) return session.error;
  if (session.metadata?.reconnecting) return "Reconnecting...";
  return session.status;
}

function StatusDot({ session }: { session: Session }) {
  const tone =
    session.status === "connected"
      ? "text-(--c-state-connected)"
      : session.status === "connecting"
        ? "text-(--c-state-connecting) animate-pulse motion-reduce:animate-none"
        : "text-(--c-state-error)";
  return (
    <span className={cx("flex", tone)} title={statusTitle(session)}>
      <CircleFilledIcon size={12} />
    </span>
  );
}

function TabIcon({ session }: { session: Session }) {
  const entryId = session.entryId;
  const entry = useEntryStore((s) =>
    entryId ? s.entries.find((e) => e.id === entryId) : undefined,
  );
  const view = session.type === "dashboard" ? dashboardViewOf(session) : null;
  const folderId = view?.kind === "folder" ? view.folderId : null;
  const folder = useEntryStore((s) => (folderId ? s.folders.find((f) => f.id === folderId) : undefined));

  if (folder) {
    const Icon = getEntryIcon("folder", false, folder.icon);
    const colorResult = getEntryColor("folder", folder.color);
    return (
      <span className="flex">
        <Icon size={16} className={colorResult.className} style={colorResult.style} />
      </span>
    );
  }

  if (entry) {
    const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
    const colorResult = getEntryColor(entry.entry_type, entry.color);
    return (
      <span className="flex">
        <Icon size={16} className={colorResult.className} style={colorResult.style} />
      </span>
    );
  }

  if (view?.kind === "home") {
    return <span className="flex"><HomeIcon size={16} className="text-link" /></span>;
  }

  return <span className="flex">{typeIcons[session.type]}</span>;
}
