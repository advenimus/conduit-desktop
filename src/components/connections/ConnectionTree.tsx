import { useState, useRef, useEffect } from "react";
import { invoke } from "../../lib/electron";
import {
  useConnectionStore,
  ConnectionType,
  SavedConnection,
  Folder as FolderType,
} from "../../stores/connectionStore";
import { useSessionStore } from "../../stores/sessionStore";
import { showContextMenu, type PopupMenuItem } from "../../utils/contextMenu";
import {
  ChevronDownIcon, ChevronRightIcon, DesktopIcon, FolderIcon, FolderOpenIcon, GlobeIcon, ServerAltIcon, TerminalIcon
} from "../../lib/icons";

interface TreeNode {
  id: string;
  name: string;
  type: "folder" | ConnectionType;
  children?: TreeNode[];
  parentId?: string;
}


export default function ConnectionTree() {
  const {
    connections,
    folders,
    moveConnection,
    moveFolder,
    updateConnection,
    removeConnection,
    renameFolder,
    removeFolder,
  } = useConnectionStore();
  const { addSession } = useSessionStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getIcon = (type: string) => {
    switch (type) {
      case "folder":
        return FolderIcon;
      case "ssh":
        return TerminalIcon;
      case "rdp":
        return DesktopIcon;
      case "vnc":
        return ServerAltIcon;
      case "web":
        return GlobeIcon;
      case "local_shell":
        return TerminalIcon;
      default:
        return ServerAltIcon;
    }
  };

  const handleOpenConnection = async (node: TreeNode) => {
    const conn = connections.find((c) => c.id === node.id);
    if (!conn) return;

    let sessionId = conn.id;
    let metadata: Record<string, unknown> | undefined;

    try {
      if (conn.type === "web") {
        const url = conn.host || conn.name;
        sessionId = await invoke<string>("web_session_create", { url });
      } else if (conn.type === "ssh") {
        sessionId = await invoke<string>("ssh_session_create", {
          host: conn.host,
          port: conn.port ?? 22,
          credentialId: conn.credentialId ?? null,
        });
      } else if (conn.type === "rdp") {
        // Measure content area for dynamic resolution
        const contentEl = document.querySelector('[data-content-area]');
        let w = contentEl?.clientWidth ?? (window.innerWidth - 250);
        let h = contentEl?.clientHeight ?? (window.innerHeight - 40);
        w = Math.max(800, w - (w % 2));
        h = Math.max(600, h - (h % 2));

        // Add session instantly in "connecting" state
        addSession({
          id: conn.id,
          type: "rdp",
          title: conn.name,
          status: "connecting",
        });

        // Connect in background
        invoke<{ sessionId: string; width: number; height: number; mode: string }>("rdp_connect", {
          sessionId: conn.id,
          host: conn.host,
          port: conn.port ?? 3389,
          username: "",
          password: "",
          width: w,
          height: h,
        }).then((result) => {
          useSessionStore.getState().addSession({
            id: conn.id,
            type: "rdp",
            title: conn.name,
            status: "connected",
            metadata: {
              rdpWidth: result.width,
              rdpHeight: result.height,
              rdpMode: result.mode,
            },
          });
        }).catch((err) => {
          const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed";
          useSessionStore.getState().updateSessionStatus(conn.id, "disconnected", msg);
        });
        return; // Don't fall through
      } else if (conn.type === "vnc") {
        await invoke("vnc_connect", {
          sessionId: conn.id,
          host: conn.host,
          port: conn.port ?? 5900,
          password: "",
        });
      }
    } catch (err) {
      console.error("[ConnectionTree] Failed to create session:", err);
      return;
    }

    addSession({
      id: sessionId,
      type: conn.type,
      title: conn.name,
      status: "connected",
      metadata,
    });
  };

  const handleContextMenu = async (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    const items: PopupMenuItem[] = [
      { id: "rename", label: "Rename", icon: "rename" },
      { id: "delete", label: "Delete", variant: "danger", icon: "trash" },
    ];

    const selected = await showContextMenu(e.clientX, e.clientY, items);
    if (!selected) return;

    switch (selected) {
      case "rename":
        startRename(node);
        break;
      case "delete":
        handleDelete(node);
        break;
    }
  };

  const startRename = (node: TreeNode) => {
    setRenamingId(node.id);
    setRenameValue(node.name);
  };

  const commitRename = (node: TreeNode) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      if (node.type === "folder") {
        renameFolder(node.id, trimmed);
      } else {
        updateConnection(node.id, { name: trimmed });
      }
    }
    setRenamingId(null);
  };

  const handleDelete = async (node: TreeNode) => {
    if (node.type === "folder") {
      removeFolder(node.id);
    } else {
      await removeConnection(node.id);
    }
  };

  // Context menu items are built inline in handleContextMenu

  const renderNode = (node: TreeNode, depth: number = 0) => {
    const isFolder = node.type === "folder";
    const isExpanded = expandedFolders.has(node.id);
    const isSelected = selectedId === node.id;
    const isRenaming = renamingId === node.id;
    const Icon = isFolder
      ? isExpanded
        ? FolderOpenIcon
        : FolderIcon
      : getIcon(node.type);

    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-1 px-2 py-1 cursor-pointer rounded ${
            isSelected
              ? "bg-conduit-600/20 text-conduit-400"
              : "hover:bg-raised/50"
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            setSelectedId(node.id);
            if (isFolder) {
              toggleFolder(node.id);
            }
          }}
          onDoubleClick={() => {
            if (!isFolder) {
              handleOpenConnection(node);
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, node)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("node", JSON.stringify(node));
          }}
          onDragOver={(e) => {
            if (isFolder) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            if (isFolder) {
              e.preventDefault();
              const data = e.dataTransfer.getData("node");
              if (data) {
                const draggedNode = JSON.parse(data) as TreeNode;
                if (draggedNode.type === "folder") {
                  moveFolder(draggedNode.id, node.id);
                } else {
                  moveConnection(draggedNode.id, node.id);
                }
              }
            }
          }}
        >
          {isFolder && (
            <button className="p-0.5">
              {isExpanded ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
            </button>
          )}
          {!isFolder && <span className="w-4" />}
          <Icon size={16} className="flex-shrink-0" />
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="text-sm bg-raised text-ink border border-conduit-500 rounded px-1 outline-none min-w-0 flex-1"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(node);
                if (e.key === "Escape") setRenamingId(null);
              }}
              onBlur={() => commitRename(node)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="text-sm truncate">{node.name}</span>
          )}
        </div>

        {isFolder && isExpanded && node.children && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const buildTree = (): TreeNode[] => {
    const rootNodes: TreeNode[] = [];
    const folderMap = new Map<string, TreeNode>();

    // Create folder nodes
    folders.forEach((folder: FolderType) => {
      folderMap.set(folder.id, {
        id: folder.id,
        name: folder.name,
        type: "folder",
        children: [],
        parentId: folder.parentId,
      });
    });

    // Add connections to folders or root
    connections.forEach((conn: SavedConnection) => {
      const node: TreeNode = {
        id: conn.id,
        name: conn.name,
        type: conn.type,
        parentId: conn.folderId,
      };

      if (conn.folderId && folderMap.has(conn.folderId)) {
        folderMap.get(conn.folderId)!.children!.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    // Build folder hierarchy
    folderMap.forEach((folder) => {
      if (folder.parentId && folderMap.has(folder.parentId)) {
        folderMap.get(folder.parentId)!.children!.push(folder);
      } else if (!folder.parentId) {
        rootNodes.push(folder);
      }
    });

    return rootNodes;
  };

  const tree = buildTree();

  if (tree.length === 0) {
    return (
      <div className="mt-2 text-center text-sm text-ink-faint">
        No connections yet
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((node) => renderNode(node))}
    </div>
  );
}
