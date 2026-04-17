import { useState, useRef, useEffect } from "react";
import { CloseIcon, PlusIcon, TerminalIcon, DesktopIcon, GlobeIcon, FileTextIcon, PlayerPlayIcon, InfoCircleIcon, HomeIcon } from "../../lib/icons";
import { useSessionStore, SessionType } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import { showContextMenu, type PopupMenuItem } from "../../utils/contextMenu";
import { invoke } from "../../lib/electron";
import { useTierStore } from "../../stores/tierStore";
import { toast } from "../common/Toast";
import { openDashboardForEntry } from "../../lib/openDashboard";

const typeIcons: Record<SessionType, React.ReactNode> = {
  local_shell: <TerminalIcon size={14} />,
  ssh: <TerminalIcon size={14} />,
  rdp: <DesktopIcon size={14} />,
  vnc: <DesktopIcon size={14} />,
  web: <GlobeIcon size={14} />,
  document: <FileTextIcon size={14} />,
  command: <PlayerPlayIcon size={14} />,
  dashboard: <InfoCircleIcon size={14} />,
};

export default function TabBar() {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    closeSession,
    createLocalShell,
    updateSessionTitle,
    reorderSession,
  } = useSessionStore();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleNewShell = async (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = rect.right;
    const y = rect.bottom;

    const cliAgentsEnabled = useTierStore.getState().cliAgentsEnabled;
    const items: PopupMenuItem[] = [
      { id: "home", label: "Home Directory", icon: "home" },
      ...(cliAgentsEnabled ? [
        { id: "sep1", label: "", type: "separator" as const },
        { id: "agent_header", label: "Agent Directory", type: "header" as const },
        { id: "agent_claude", label: "Claude Code", icon: "terminal" },
        { id: "agent_codex", label: "Codex", icon: "terminal" },
      ] : []),
      { id: "sep2", label: "", type: "separator" },
      { id: "browse", label: "Browse...", icon: "folder" },
    ];

    const selected = await showContextMenu(x, y, items, { anchorRight: true });
    if (!selected) return;

    try {
      switch (selected) {
        case "home":
          await createLocalShell();
          break;
        case "agent_claude": {
          const dir = await invoke<string>("get_agent_working_dir", { engineType: "claude-code" });
          await createLocalShell(undefined, dir);
          break;
        }
        case "agent_codex": {
          const dir = await invoke<string>("get_agent_working_dir", { engineType: "codex" });
          await createLocalShell(undefined, dir);
          break;
        }
        case "browse": {
          const folder = await invoke<string | null>("dialog_select_folder", { title: "Select Working Directory" });
          if (folder) {
            await createLocalShell(undefined, folder);
          }
          break;
        }
      }
    } catch (error) {
      console.error("Failed to create local shell:", error);
    }
  };

  const handleCloseTab = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.stopPropagation();
    await closeSession(sessionId);
  };

  const handleContextMenu = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const session = sessions.find((s) => s.id === sessionId);
    const entryId = session?.entryId;
    const entry = entryId ? useEntryStore.getState().entries.find((en) => en.id === entryId) : undefined;

    const items: PopupMenuItem[] = [];
    items.push({ id: "rename", label: "Rename", icon: "rename" });
    if (entryId && session?.type !== "dashboard" && session?.type !== "document") {
      const isReconnecting = session?.metadata?.reconnecting === true;
      items.push({
        id: "reconnect",
        label: isReconnecting ? "Reconnecting..." : "Reconnect",
        icon: "reconnect",
      });
    }
    if (entryId && session?.type !== "dashboard") {
      items.push({ id: "view_info", label: "View Info", icon: "home" });
    }
    if (session?.type === "rdp" && session?.status === "connected") {
      items.push({ id: "send_cad", label: "Send Ctrl+Alt+Delete", icon: "key" });
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
    items.push({ id: "sep2", label: "", type: "separator" });
    items.push({ id: "close", label: "Close Session", variant: "danger", icon: "close" });

    const selected = await showContextMenu(e.clientX, e.clientY, items);
    if (!selected) return;

    switch (selected) {
      case "rename": {
        const s = sessions.find((ss) => ss.id === sessionId);
        if (s) {
          setRenamingId(sessionId);
          setRenameValue(s.title);
        }
        break;
      }
      case "reconnect": {
        const s = sessions.find((ss) => ss.id === sessionId);
        if (!s?.metadata?.reconnecting) {
          useEntryStore.getState().reconnectSession(sessionId);
        }
        break;
      }
      case "copy_username": {
        if (entryId) {
          const cred = await useEntryStore.getState().resolveCredential(entryId);
          if (cred?.username) {
            await navigator.clipboard.writeText(cred.username);
            toast.success("Username copied");
          } else {
            toast.error("No username available");
          }
        }
        break;
      }
      case "copy_password": {
        if (entryId) {
          const cred = await useEntryStore.getState().resolveCredential(entryId);
          if (cred?.password) {
            await navigator.clipboard.writeText(cred.password);
            toast.success("Password copied");
          } else {
            toast.error("No password available");
          }
        }
        break;
      }
      case "send_cad":
        await invoke("rdp_send_key", { sessionId, key: "Delete", modifiers: ["ctrl", "alt"] });
        break;
      case "view_info":
        if (entryId) openDashboardForEntry(entryId);
        break;
      case "close":
        closeSession(sessionId);
        break;
    }
  };

  const commitRename = (sessionId: string) => {
    const trimmed = renameValue.trim();
    const session = sessions.find((s) => s.id === sessionId);
    if (trimmed && session && trimmed !== session.title) {
      updateSessionTitle(sessionId, trimmed);
    }
    setRenamingId(null);
  };

  return (
    <div className="flex items-center h-9">
      {/* Tabs */}
      <div className="flex items-center flex-1 overflow-x-auto">
        {sessions.map((session, index) => (
          <div
            key={session.id}
            draggable={renamingId !== session.id}
            onDragStart={(e) => {
              setDragIndex(index);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropIndex(index);
            }}
            onDragLeave={() => setDropIndex(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== index) {
                reorderSession(dragIndex, index);
              }
              setDragIndex(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDropIndex(null);
            }}
            onClick={() => setActiveSession(session.id)}
            onContextMenu={(e) => handleContextMenu(e, session.id)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border-r border-stroke min-w-0 transition-colors ${
              activeSessionId === session.id
                ? "bg-[color-mix(in_srgb,var(--c-accent-500)_10%,var(--c-panel))] text-ink font-medium"
                : "text-ink-muted hover:bg-raised hover:text-ink-secondary"
            }${dragIndex !== null && dropIndex === index && dragIndex !== index
              ? " border-l-2 border-l-conduit-500"
              : ""
            }${dragIndex === index ? " opacity-50" : ""}`}
          >
            {/* Session type icon */}
            <TabIcon sessionType={session.type} entryId={session.entryId} />

            {/* Session title */}
            {renamingId === session.id ? (
              <input
                ref={renameInputRef}
                className="text-sm bg-raised text-ink border border-conduit-500 rounded px-1 outline-none min-w-0 max-w-[120px]"
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
              <span className="truncate max-w-[120px]">{session.title}</span>
            )}

            {/* Connection status indicator */}
            <span
              className={`flex-shrink-0 w-2 h-2 rounded-full ${
                session.status === "connected"
                  ? "bg-green-500"
                  : session.status === "connecting"
                    ? "bg-yellow-500 animate-pulse"
                    : "bg-red-500"
              }`}
              title={
                session.status === "disconnected" && session.error
                  ? session.error
                  : session.metadata?.reconnecting
                    ? "Reconnecting..."
                    : session.status
              }
            />

            {/* Close button */}
            <button
              onClick={(e) => handleCloseTab(e, session.id)}
              className="flex-shrink-0 p-0.5 rounded hover:bg-raised"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* New Tab Button */}
      <button
        onClick={(e) => handleNewShell(e)}
        className="flex items-center justify-center w-10 h-full hover:bg-raised"
        title="New Local Shell"
      >
        <PlusIcon size={16} />
      </button>
    </div>
  );
}

function TabIcon({ sessionType, entryId }: { sessionType: SessionType; entryId?: string }) {
  const entry = useEntryStore((s) => entryId ? s.entries.find((e) => e.id === entryId) : undefined);

  if (entry) {
    const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
    const colorResult = getEntryColor(entry.entry_type, entry.color);
    return (
      <span className="flex-shrink-0">
        <Icon size={14} className={colorResult.className} style={colorResult.style} />
      </span>
    );
  }

  if (sessionType === "dashboard" && !entryId) {
    return <span className="flex-shrink-0"><HomeIcon size={14} className="text-conduit-400" /></span>;
  }

  return <span className="flex-shrink-0">{typeIcons[sessionType]}</span>;
}
