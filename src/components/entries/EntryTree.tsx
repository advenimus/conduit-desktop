import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useTierStore } from "../../stores/tierStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { invoke } from "../../lib/electron";
import { getEntryIcon, getEntryColor } from "./entryIcons";
import ConfirmDialog from "../common/ConfirmDialog";
import ConflictDot from "../sync/ConflictDot";
import { showContextMenu, type PopupMenuItem } from "../../utils/contextMenu";
import { getTypeableActiveSession, typeIntoActiveSession, typeUsernameTabPassword, globalTypeText, globalTypeUsernameTabPassword } from "../../utils/autotype";
import { toast } from "../common/Toast";
import { generateTotpCode } from "../../lib/totp";
import { openDashboardForEntry } from "../../lib/openDashboard";
import UpgradeBanner from "../upgrade/UpgradeBanner";
import CredentialPicker from "../vault/CredentialPicker";
import type { EntryType, EntryMeta, FolderData } from "../../types/entry";
import {
  ChevronDownIcon, ChevronRightIcon, LockIcon, StarFilledIcon, UsersIcon
} from "../../lib/icons";
import { cx } from "../ui";

interface TreeNode {
  id: string;
  name: string;
  kind: "folder" | "entry";
  entryType?: EntryType;
  customIcon?: string | null;
  customColor?: string | null;
  children?: TreeNode[];
  sortOrder: number;
}

interface FolderGroup {
  path: string;
  entries: TreeNode[];
}

interface EntryTreeProps {
  searchQuery?: string;
  showFavoritesOnly?: boolean;
}

/** Row inset and indent per tree level (spec 3.6, 4.14). */
const ROW_INSET_PX = 4;
const INDENT_PX = 8;
/** The first indent guide runs through the middle of a top-level row's 16px twistie. */
const GUIDE_OFFSET_PX = ROW_INSET_PX + 8;

function rowStateClass(isDragOver: boolean, isLocked: boolean, isSelected: boolean): string {
  if (isDragOver) return "bg-(--c-drop-bg) outline outline-1 -outline-offset-1 outline-accent text-ink-secondary";
  if (isLocked) return "opacity-60 text-ink-faint";
  if (isSelected) return "bg-selected text-ink";
  return "hover:bg-hover text-ink-secondary";
}

/** One 1px line per ancestor level, shown while the tree is hovered or focused. */
function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, k) => (
        <span
          key={k}
          data-indent-guide=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-px bg-(--c-indent-guide) opacity-0 transition-opacity duration-100 group-hover/tree:opacity-100 group-focus-within/tree:opacity-100"
          style={{ left: `${GUIDE_OFFSET_PX + k * INDENT_PX}px` }}
        />
      ))}
    </>
  );
}

function saveExpandedFolders(folders: Set<string>, favoritesMode: boolean, vid: string | null): void {
  if (!vid) return;
  const base = favoritesMode ? "expanded-folders-favorites" : "expanded-folders";
  invoke("ui_state_set", { key: `${base}::${vid}`, value: [...folders] }).catch(() => {});
}

/**
 * Check whether dropping `movingId` onto `targetId` would create a cycle.
 * Walks the target's parent chain (parent_entry_id for entries, parent_id for
 * folders) looking for movingId.
 */
function wouldCreateCycle(
  movingId: string,
  targetId: string,
  targetKind: "folder" | "entry",
  entries: EntryMeta[],
  folders: FolderData[],
): boolean {
  if (movingId === targetId) return true;
  const visited = new Set<string>();

  if (targetKind === "entry") {
    const entryMap = new Map(entries.map((e) => [e.id, e]));
    let current: EntryMeta | undefined = entryMap.get(targetId);
    while (current) {
      if (visited.has(current.id)) return true;
      visited.add(current.id);
      if (current.parent_entry_id === movingId) return true;
      current = current.parent_entry_id ? entryMap.get(current.parent_entry_id) : undefined;
    }
    return false;
  }

  const folderMap = new Map(folders.map((f) => [f.id, f]));
  let current = folderMap.get(targetId);
  while (current) {
    if (visited.has(current.id)) return true;
    visited.add(current.id);
    if (current.parent_id === movingId) return true;
    current = current.parent_id ? folderMap.get(current.parent_id) : undefined;
  }
  return false;
}

export default function EntryTree({ searchQuery, showFavoritesOnly }: EntryTreeProps) {
  const {
    entries,
    folders,
    selectedEntryIds,
    setSelectedEntry,
    toggleSelectedEntry,
    clearSelection,
    openEntry,
    openEntryWithCredential,
    deleteEntry,
    deleteFolder,
    moveEntries,
    moveFolders,
    updateEntry,
    updateFolder,
    resolveCredential,
    duplicateEntry,
    getEntry,
  } = useEntryStore();

  const lockedEntryIds = useTierStore((s) => s.lockedEntryIds);
  const isEntryLocked = useTierStore((s) => s.isEntryLocked);
  const maxConnections = useTierStore((s) => s.maxConnections);
  const authMode = useAuthStore((s) => s.authMode);
  const vaultType = useVaultStore((s) => s.vaultType);
  const currentVaultPath = useVaultStore((s) => s.currentVaultPath);
  const teamVaultId = useVaultStore((s) => s.teamVaultId);

  const vaultId = vaultType === "team" && teamVaultId
    ? `team::${teamVaultId}`
    : currentVaultPath
      ? `personal::${currentVaultPath}`
      : null;

  const getEffectiveRole = useTeamStore((s) => s.getEffectiveRole);
  const canManagePerms = useTeamStore((s) => s.canManagePermissions);

  const [expandedAll, setExpandedAll] = useState<Set<string>>(new Set());
  const [expandedFav, setExpandedFav] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ node: TreeNode } | null>(null);
  const [multiDeleteConfirm, setMultiDeleteConfirm] = useState<{ count: number; ids: Array<{ id: string; kind: "folder" | "entry" }> } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const [credPickerEntryId, setCredPickerEntryId] = useState<string | null>(null);

  const connectionCount = useMemo(() => entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').length, [entries]);

  // Whether we're in a flat display mode (no folder structure shown)
  const isFlatMode = !!(searchQuery || showFavoritesOnly);

  // Select the active expanded set based on view mode
  const expandedFolders = showFavoritesOnly ? expandedFav : expandedAll;
  const setExpandedFolders = showFavoritesOnly ? setExpandedFav : setExpandedAll;

  // Load persisted expanded folders when vault changes
  useEffect(() => {
    if (!vaultId) {
      setExpandedAll(new Set());
      setExpandedFav(new Set());
      return;
    }
    invoke<string[] | null>("ui_state_get", { key: `expanded-folders::${vaultId}` })
      .then((arr) => setExpandedAll(arr?.length ? new Set(arr) : new Set()))
      .catch(() => setExpandedAll(new Set()));
    invoke<string[] | null>("ui_state_get", { key: `expanded-folders-favorites::${vaultId}` })
      .then((arr) => setExpandedFav(arr?.length ? new Set(arr) : new Set()))
      .catch(() => setExpandedFav(new Set()));
  }, [vaultId]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Listen for delete-selected event (from Delete/Backspace key)
  useEffect(() => {
    const handleDeleteSelected = () => {
      const state = useEntryStore.getState();
      const selIds = state.selectedEntryIds;
      if (selIds.size === 0) return;

      if (selIds.size > 1) {
        // Multi-delete
        const items: Array<{ id: string; kind: "folder" | "entry" }> = [];
        for (const id of selIds) {
          const folder = state.folders.find((f) => f.id === id);
          if (folder) {
            items.push({ id, kind: "folder" });
            continue;
          }
          const entry = state.entries.find((e) => e.id === id);
          if (entry) {
            items.push({ id, kind: "entry" });
          }
        }
        if (items.length > 0) {
          setMultiDeleteConfirm({ count: items.length, ids: items });
        }
        return;
      }

      // Single delete (existing behavior)
      const currentId = state.selectedEntryId;
      if (!currentId) return;

      const folder = state.folders.find((f) => f.id === currentId);
      if (folder) {
        setDeleteConfirm({
          node: { id: folder.id, name: folder.name, kind: "folder", sortOrder: folder.sort_order },
        });
        return;
      }
      const entry = state.entries.find((e) => e.id === currentId);
      if (entry) {
        setDeleteConfirm({
          node: { id: entry.id, name: entry.name, kind: "entry", entryType: entry.entry_type, sortOrder: entry.sort_order },
        });
      }
    };

    document.addEventListener("conduit:delete-selected", handleDeleteSelected);
    return () => document.removeEventListener("conduit:delete-selected", handleDeleteSelected);
  }, []);

  // Prune stale folder IDs when folders change (both sets)
  useEffect(() => {
    if (!vaultId) return;
    const folderIds = new Set(folders.map((f) => f.id));
    if (folderIds.size === 0) return;
    const pruneSet = (setter: typeof setExpandedAll, favMode: boolean) => {
      setter((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const id of prev) {
          if (folderIds.has(id)) {
            next.add(id);
          } else {
            changed = true;
          }
        }
        if (changed) {
          saveExpandedFolders(next, favMode, vaultId);
          return next;
        }
        return prev;
      });
    };
    pruneSet(setExpandedAll, false);
    pruneSet(setExpandedFav, true);
  }, [folders, vaultId]);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      saveExpandedFolders(next, !!showFavoritesOnly, vaultId);
      return next;
    });
  }, [setExpandedFolders, showFavoritesOnly, vaultId]);

  const startRename = useCallback((node: TreeNode) => {
    setRenamingId(node.id);
    setRenameValue(node.name);
  }, []);

  const commitRename = useCallback((node: TreeNode) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      if (node.kind === "folder") {
        updateFolder(node.id, { name: trimmed });
      } else {
        updateEntry(node.id, { name: trimmed });
      }
    }
    setRenamingId(null);
  }, [renameValue, updateFolder, updateEntry]);

  const handleDelete = useCallback((node: TreeNode) => {
    setDeleteConfirm({ node });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const { node } = deleteConfirm;
    if (node.kind === "folder") {
      await deleteFolder(node.id);
    } else {
      await deleteEntry(node.id);
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, deleteFolder, deleteEntry]);

  const confirmMultiDelete = useCallback(async () => {
    if (!multiDeleteConfirm) return;
    for (const item of multiDeleteConfirm.ids) {
      if (item.kind === "folder") {
        await deleteFolder(item.id);
      } else {
        await deleteEntry(item.id);
      }
    }
    clearSelection();
    setMultiDeleteConfirm(null);
  }, [multiDeleteConfirm, deleteFolder, deleteEntry, clearSelection]);

  const handleDoubleClick = useCallback((node: TreeNode) => {
    if (node.kind === "entry" && node.entryType !== "credential") {
      if (isEntryLocked(node.id)) {
        toast.error("This entry is locked — upgrade your plan to access it");
        return;
      }
      // Double-click opens just this entry; clear multi-selection
      setSelectedEntry(node.id);
      openEntry(node.id);
    }
  }, [openEntry, isEntryLocked, setSelectedEntry]);

  const handleEdit = useCallback((nodeId: string) => {
    document.dispatchEvent(new CustomEvent("conduit:edit-entry", { detail: nodeId }));
  }, []);

  const handleCopyHost = useCallback(async (nodeId: string) => {
    const entry = entries.find((e) => e.id === nodeId);
    if (entry?.host) {
      await navigator.clipboard.writeText(entry.host);
      toast.success("Host copied");
    }
  }, [entries]);

  const handleCopyUsername = useCallback(async (nodeId: string) => {
    const cred = await resolveCredential(nodeId);
    if (cred?.username) {
      await navigator.clipboard.writeText(cred.username);
      toast.success("Username copied");
    } else {
      toast.error("No username available");
    }
  }, [resolveCredential]);

  const handleCopyPassword = useCallback(async (nodeId: string) => {
    const cred = await resolveCredential(nodeId);
    if (cred?.password) {
      await navigator.clipboard.writeText(cred.password);
      toast.success("Password copied");
    } else {
      toast.error("No password available");
    }
  }, [resolveCredential]);

  const handleToggleFavorite = useCallback((nodeId: string) => {
    const entry = entries.find((e) => e.id === nodeId);
    if (entry) {
      updateEntry(nodeId, { is_favorite: !entry.is_favorite });
    }
  }, [entries, updateEntry]);

  /**
   * Handle drop of items onto a target node.
   * - targetId === null  → drop on the root zone
   * - target is a folder → set folder_id on dropped entries; reparent dropped folders
   * - target is an entry → set parent_entry_id on dropped entries; folders cannot
   *   be nested under entries (those drops are skipped)
   */
  const handleDrop = useCallback(async (e: React.DragEvent, targetId: string | null) => {
    e.preventDefault();
    setDragOverFolderId(null);
    setDragOverRoot(false);

    const data = e.dataTransfer.getData("application/conduit-node");
    if (!data) return;

    const items = JSON.parse(data) as Array<{ id: string; kind: string }>;

    const targetIsEntry = targetId ? entries.some((en) => en.id === targetId) : false;
    const targetIsFolder = targetId ? folders.some((f) => f.id === targetId) : false;
    const targetKind: "folder" | "entry" | "root" = targetId === null
      ? "root"
      : targetIsEntry
        ? "entry"
        : targetIsFolder
          ? "folder"
          : "root";

    const entryIdsToMove: string[] = [];
    const folderIdsToMove: string[] = [];
    let skipped = 0;
    let folderOnEntryRejected = 0;

    for (const item of items) {
      // Skip self-drop
      if (item.id === targetId) { skipped++; continue; }

      // Folders cannot be nested under entries.
      if (item.kind === "folder" && targetKind === "entry") {
        folderOnEntryRejected++;
        continue;
      }

      // Cycle detection: folder→folder uses folder chain, entry→entry uses entry chain.
      if (targetId && targetKind !== "root") {
        if (item.kind === "folder" && targetKind === "folder") {
          if (wouldCreateCycle(item.id, targetId, "folder", entries, folders)) {
            skipped++;
            continue;
          }
        } else if (item.kind === "entry" && targetKind === "entry") {
          if (wouldCreateCycle(item.id, targetId, "entry", entries, folders)) {
            skipped++;
            continue;
          }
        }
      }

      // Skip permission-denied items in team vaults
      if (vaultType === "team") {
        const entry = entries.find((en) => en.id === item.id);
        const folder = folders.find((f) => f.id === item.id);
        const parentFolderId = item.kind === "entry" ? entry?.folder_id : folder?.parent_id;
        const role = getEffectiveRole(parentFolderId ?? undefined) ?? "viewer";
        if (role !== "admin" && role !== "editor") {
          skipped++;
          continue;
        }
      }

      if (item.kind === "folder") {
        folderIdsToMove.push(item.id);
      } else {
        entryIdsToMove.push(item.id);
      }
    }

    if (skipped > 0) {
      toast.info(`${skipped} item${skipped > 1 ? "s" : ""} skipped (circular reference or insufficient permissions)`);
    }
    if (folderOnEntryRejected > 0) {
      toast.info(`${folderOnEntryRejected} folder${folderOnEntryRejected > 1 ? "s" : ""} skipped — folders cannot be nested under entries`);
    }

    // Resolve the target for entries and folders separately.
    // Entries: either set folder_id (folder/root target) or parent_entry_id (entry target).
    // Folders: only ever set parent_id (folder/root target — entries already filtered out).
    const entryTarget: { folder_id?: string | null; parent_entry_id?: string | null } =
      targetKind === "entry"
        ? { parent_entry_id: targetId! }
        : { folder_id: targetId };

    const folderTargetId = targetKind === "entry" ? null : targetId;

    const results = await Promise.all([
      entryIdsToMove.length > 0 ? moveEntries(entryIdsToMove, entryTarget) : { moved: 0, failed: 0 },
      folderIdsToMove.length > 0 ? moveFolders(folderIdsToMove, folderTargetId) : { moved: 0, failed: 0 },
    ]);

    const totalFailed = results[0].failed + results[1].failed;
    if (totalFailed > 0) {
      toast.error(`Failed to move ${totalFailed} item${totalFailed > 1 ? "s" : ""}`);
    }

    // Auto-expand the target after a successful move so the user sees the
    // moved items immediately. Works for folders AND entries-with-children.
    if (targetId && (results[0].moved > 0 || results[1].moved > 0)) {
      setExpandedFolders((prev) => {
        if (prev.has(targetId)) return prev;
        const next = new Set(prev);
        next.add(targetId);
        saveExpandedFolders(next, !!showFavoritesOnly, vaultId);
        return next;
      });
    }
  }, [folders, entries, vaultType, getEffectiveRole, moveEntries, moveFolders, setExpandedFolders, showFavoritesOnly, vaultId]);

  const handleContextMenu = useCallback(async (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    // Multi-select context menu: if right-clicking an item in the selection with multiple items
    if (selectedEntryIds.has(node.id) && selectedEntryIds.size > 1) {
      const count = selectedEntryIds.size;
      const items: PopupMenuItem[] = [
        { id: "header", label: `${count} items selected`, type: "separator" },
        { id: "delete_multi", label: `Delete ${count} Items`, variant: "danger", icon: "trash" },
      ];
      const selected = await showContextMenu(e.clientX, e.clientY, items);
      if (selected === "delete_multi") {
        const state = useEntryStore.getState();
        const deleteItems: Array<{ id: string; kind: "folder" | "entry" }> = [];
        for (const id of selectedEntryIds) {
          if (state.folders.find((f) => f.id === id)) {
            deleteItems.push({ id, kind: "folder" });
          } else if (state.entries.find((en) => en.id === id)) {
            deleteItems.push({ id, kind: "entry" });
          }
        }
        setMultiDeleteConfirm({ count: deleteItems.length, ids: deleteItems });
      }
      return;
    }

    // Not in multi-selection: clear selection and select this item
    if (!selectedEntryIds.has(node.id)) {
      setSelectedEntry(node.id);
    }

    const items: PopupMenuItem[] = [];

    if (node.kind === "folder") {
      // For team vaults, use effective role; fall back to "viewer" if null (permissions still loading)
      const role = vaultType === "team" ? (getEffectiveRole(node.id) ?? "viewer") : "admin";
      const canEdit = role === "admin" || role === "editor";

      if (canEdit) {
        items.push({ id: "new_entry", label: "New Entry", icon: "plus" });
        items.push({ id: "new_folder", label: "New Folder", icon: "folderPlus" });
        items.push({ id: "sep1", label: "", type: "separator" });
        items.push({ id: "edit_folder", label: "Edit Folder", icon: "pencil" });
        items.push({ id: "rename", label: "Rename", icon: "textCursor" });
      }
      if (vaultType === "team" && canManagePerms()) {
        items.push({ id: "sep_perms", label: "", type: "separator" });
        items.push({ id: "manage_permissions", label: "Manage Permissions", icon: "shield" });
      }
      if (role === "admin") {
        items.push({ id: "sep2", label: "", type: "separator" });
        items.push({ id: "delete", label: "Delete", variant: "danger", icon: "trash" });
      }
    } else {
      const entry = entries.find((en) => en.id === node.id);
      const parentFolderId = entry?.folder_id;
      // For team vaults, use effective role; fall back to "viewer" if null (permissions still loading)
      const role = vaultType === "team" ? (getEffectiveRole(parentFolderId ?? undefined) ?? "viewer") : "admin";
      const canEdit = role === "admin" || role === "editor";
      const isConnection = node.entryType !== "credential";
      const isCredential = node.entryType === "credential";
      const locked = isEntryLocked(node.id);

      // For credential entries, fetch full entry to check for TOTP
      let hasTotp = false;
      if (isCredential && !locked) {
        try {
          const full = await getEntry(node.id);
          hasTotp = !!full?.totp_secret;
        } catch { /* ignore — just won't show OTP option */ }
      }

      if (locked) {
        // Locked entries: only upgrade prompt + delete (to free up slots)
        items.push({ id: "upgrade", label: "Upgrade to Access", icon: "lock" });
        items.push({ id: "sep1", label: "", type: "separator" });
        if (role === "admin") {
          items.push({ id: "delete", label: "Delete", variant: "danger", icon: "trash" });
        }
      } else {
        if (isConnection) {
          items.push({ id: "open", label: "Open Session", icon: "playerPlay" });
          const openWithChildren: PopupMenuItem[] = [
            { id: "open_external", label: "Open External", icon: "externalLink" },
          ];
          if (node.entryType !== "web") {
            openWithChildren.push({
              id: "open_with_credential", label: "Open with Credential\u2026", icon: "key",
            });
          }
          items.push({ id: "open_with", label: "Open With", icon: "ellipsis", children: openWithChildren });
        }
        items.push({ id: "view_info", label: "View Info", icon: "home" });
        items.push({ id: "sep0", label: "", type: "separator" });
        if (canEdit) {
          items.push({ id: "edit", label: "Edit", icon: "pencil" });
        }
        if (isConnection && entry?.host) {
          items.push({ id: "copy_host", label: "Copy Host", icon: "server" });
        }
        if (entry?.username || entry?.credential_id) {
          items.push({ id: "copy_username", label: "Copy Username", icon: "user" });
        }
        items.push({ id: "copy_password", label: "Copy Password", icon: "key" });
        if (hasTotp) {
          items.push({ id: "copy_otp", label: "Copy OTP", icon: "clock" });
        }
        const autoTypeChildren: PopupMenuItem[] = [
          { id: "autotype_username", label: "Type Username", icon: "user" },
          { id: "autotype_password", label: "Type Password", icon: "key" },
          { id: "autotype_username_tab_password", label: "Type Both (Tab Between)", icon: "keyboard" },
        ];
        items.push({ id: "autotype", label: "Auto-type", icon: "keyboard", children: autoTypeChildren });
        items.push({ id: "sep1", label: "", type: "separator" });
        items.push({ id: "favorite", label: entry?.is_favorite ? "Unfavorite" : "Favorite", icon: entry?.is_favorite ? "starFilled" : "star" });
        if (canEdit) {
          items.push({ id: "rename", label: "Rename", icon: "textCursor" });
          items.push({ id: "duplicate", label: "Duplicate", icon: "copy" });
        }
        if (role === "admin") {
          items.push({ id: "sep2", label: "", type: "separator" });
          items.push({ id: "delete", label: "Delete", variant: "danger", icon: "trash" });
        }
      }
    }

    const selected = await showContextMenu(e.clientX, e.clientY, items);
    if (!selected) return;

    switch (selected) {
      case "upgrade":
        invoke('auth_open_pricing');
        break;
      case "new_entry":
        document.dispatchEvent(new CustomEvent("conduit:new-entry", { detail: { folderId: node.id } }));
        break;
      case "new_folder":
        document.dispatchEvent(new CustomEvent("conduit:new-folder", { detail: { parentId: node.id } }));
        break;
      case "edit_folder":
        document.dispatchEvent(new CustomEvent("conduit:edit-folder", { detail: node.id }));
        break;
      case "open":
        openEntry(node.id);
        break;
      case "view_info":
        openDashboardForEntry(node.id);
        break;
      case "open_external":
        invoke("entry_open_external", { id: node.id }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Failed to open external: ${msg}`);
        });
        break;
      case "open_with_credential":
        setCredPickerEntryId(node.id);
        break;
      case "edit":
        handleEdit(node.id);
        break;
      case "copy_host":
        handleCopyHost(node.id);
        break;
      case "copy_username":
        handleCopyUsername(node.id);
        break;
      case "copy_password":
        handleCopyPassword(node.id);
        break;
      case "copy_otp": {
        try {
          const full = await getEntry(node.id);
          if (!full?.totp_secret) { toast.error("No OTP configured"); break; }
          const { code } = generateTotpCode({ secret: full.totp_secret });
          await navigator.clipboard.writeText(code);
          toast.success("OTP copied");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to copy OTP");
        }
        break;
      }
      case "autotype_username": {
        const cred = await resolveCredential(node.id);
        if (!cred?.username) { toast.error("No username available"); break; }
        const hasSessionU = !!getTypeableActiveSession();
        toast.info(hasSessionU ? "Typing in 2s — click the target field now" : "Typing in 3s — switch to the target app now");
        try {
          if (hasSessionU) {
            await typeIntoActiveSession(cred.username);
          } else {
            await globalTypeText(cred.username);
          }
          toast.success("Username typed");
        } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to type username"); }
        break;
      }
      case "autotype_password": {
        const cred = await resolveCredential(node.id);
        if (!cred?.password) { toast.error("No password available"); break; }
        const hasSessionP = !!getTypeableActiveSession();
        toast.info(hasSessionP ? "Typing in 2s — click the target field now" : "Typing in 3s — switch to the target app now");
        try {
          if (hasSessionP) {
            await typeIntoActiveSession(cred.password);
          } else {
            await globalTypeText(cred.password);
          }
          toast.success("Password typed");
        } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to type password"); }
        break;
      }
      case "autotype_username_tab_password": {
        const cred = await resolveCredential(node.id);
        if (!cred?.username) { toast.error("No username available"); break; }
        if (!cred?.password) { toast.error("No password available"); break; }
        const hasSessionB = !!getTypeableActiveSession();
        toast.info(hasSessionB ? "Typing in 2s — click the target field now" : "Typing in 3s — switch to the target app now");
        try {
          if (hasSessionB) {
            await typeUsernameTabPassword(cred.username, cred.password);
          } else {
            await globalTypeUsernameTabPassword(cred.username, cred.password);
          }
          toast.success("Credentials typed");
        } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to type credentials"); }
        break;
      }
      case "favorite":
        handleToggleFavorite(node.id);
        break;
      case "rename":
        startRename(node);
        break;
      case "duplicate":
        duplicateEntry(node.id);
        break;
      case "manage_permissions":
        document.dispatchEvent(new CustomEvent("conduit:folder-permissions", {
          detail: { folderId: node.id, folderName: node.name },
        }));
        break;
      case "delete":
        handleDelete(node);
        break;
    }
  }, [entries, selectedEntryIds, setSelectedEntry, openEntry, openEntryWithCredential, startRename, handleDelete, handleEdit, handleCopyHost, handleCopyUsername, handleCopyPassword, handleToggleFavorite, duplicateEntry, isEntryLocked, vaultType, getEffectiveRole, canManagePerms, getEntry]);

  // Set of favorite entry IDs for quick lookup
  const favoriteIds = useMemo(
    () => new Set(entries.filter((e) => e.is_favorite).map((e) => e.id)),
    [entries]
  );

  // Build the tree from flat entries and folders
  const tree = useMemo(() => {
    const query = searchQuery?.toLowerCase() ?? "";

    // Filter entries by search
    let filteredEntries = query
      ? entries.filter(
          (e) =>
            e.name.toLowerCase().includes(query) ||
            (e.host && e.host.toLowerCase().includes(query)) ||
            (e.username && e.username.toLowerCase().includes(query))
        )
      : entries;

    // Apply favorites filter
    if (showFavoritesOnly) {
      filteredEntries = filteredEntries.filter((e) => e.is_favorite);
    }

    // If searching or showing favorites, group results by folder path
    if (query || showFavoritesOnly) {
      const folderLookup = new Map(folders.map((f) => [f.id, f]));
      const pathCache = new Map<string, string>();

      const getFolderPath = (folderId: string | null): string => {
        if (folderId === null) return "/";
        if (pathCache.has(folderId)) return pathCache.get(folderId)!;
        const segments: string[] = [];
        let current = folderLookup.get(folderId);
        while (current) {
          segments.unshift(current.name);
          current = current.parent_id ? folderLookup.get(current.parent_id) : undefined;
        }
        const path = segments.length > 0 ? segments.join(" / ") : "/";
        pathCache.set(folderId, path);
        return path;
      };

      const groups = new Map<string, FolderGroup>();
      for (const e of filteredEntries) {
        const path = getFolderPath(e.folder_id);
        if (!groups.has(path)) {
          groups.set(path, { path, entries: [] });
        }
        groups.get(path)!.entries.push({
          id: e.id,
          name: e.name,
          kind: "entry",
          entryType: e.entry_type,
          customIcon: e.icon,
          customColor: e.color,
          sortOrder: e.sort_order,
        });
      }

      for (const group of groups.values()) {
        group.entries.sort((a, b) => a.name.localeCompare(b.name));
      }

      return [...groups.values()].sort((a, b) => {
        if (a.path === "/") return -1;
        if (b.path === "/") return 1;
        return a.path.localeCompare(b.path);
      });
    }

    // Build hierarchical tree
    const folderMap = new Map<string, TreeNode>();
    const entryMap = new Map<string, TreeNode>();
    const rootNodes: TreeNode[] = [];

    // Create folder nodes (children populated below)
    for (const folder of folders) {
      folderMap.set(folder.id, {
        id: folder.id,
        name: folder.name,
        kind: "folder",
        customIcon: folder.icon,
        customColor: folder.color,
        children: [],
        sortOrder: folder.sort_order,
      });
    }

    // Create entry nodes — entries can also act as containers
    for (const entry of filteredEntries) {
      entryMap.set(entry.id, {
        id: entry.id,
        name: entry.name,
        kind: "entry",
        entryType: entry.entry_type,
        customIcon: entry.icon,
        customColor: entry.color,
        children: [],
        sortOrder: entry.sort_order,
      });
    }

    // Attach each entry to its container: parent_entry_id wins over folder_id,
    // and an entry whose parent isn't visible (e.g. filtered out by search)
    // falls back to its folder, then to root.
    for (const entry of filteredEntries) {
      const node = entryMap.get(entry.id)!;
      if (entry.parent_entry_id && entryMap.has(entry.parent_entry_id)) {
        entryMap.get(entry.parent_entry_id)!.children!.push(node);
      } else if (entry.folder_id && folderMap.has(entry.folder_id)) {
        folderMap.get(entry.folder_id)!.children!.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Build folder hierarchy
    for (const folder of folders) {
      const node = folderMap.get(folder.id)!;
      if (folder.parent_id && folderMap.has(folder.parent_id)) {
        folderMap.get(folder.parent_id)!.children!.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Sort children by sort_order then name
    const sortChildren = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        // Folders first
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        if (node.children) sortChildren(node.children);
      }
    };
    sortChildren(rootNodes);

    return rootNodes;
  }, [entries, folders, searchQuery, showFavoritesOnly]);

  const renderGroup = (group: FolderGroup) => {
    if (group.entries.length === 0) return null;
    return (
      <div key={group.path}>
        <div
          className="h-row px-2 pt-2 text-meta font-semibold text-ink-muted truncate"
          title={group.path === "/" ? "Root" : group.path}
        >
          {group.path === "/" ? "Root" : group.path}
        </div>
        {group.entries.map((node) => renderNode(node, 0))}
      </div>
    );
  };

  const renderNode = (node: TreeNode, depth: number = 0) => {
    const isFolder = node.kind === "folder";
    const hasChildren = (node.children?.length ?? 0) > 0;
    // Folders are always expandable (so empty folders still show a chevron);
    // entries are expandable only when they actually contain nested children.
    const isExpandable = isFolder || hasChildren;
    const isExpanded = expandedFolders.has(node.id);
    const isSelected = selectedEntryIds.has(node.id);
    const isRenaming = renamingId === node.id;
    const isLocked = !isFolder && lockedEntryIds.has(node.id);
    // Both folders and entries accept drops (entries become parents of nested entries).
    const isDragOver = dragOverFolderId === node.id;
    const iconType = isFolder ? "folder" : node.entryType!;
    const Icon = getEntryIcon(iconType as EntryType | "folder", isExpanded, node.customIcon);
    const colorResult = getEntryColor(iconType as EntryType | "folder", node.customColor);

    return (
      <div key={node.id}>
        <div
          data-selected={isSelected ? "" : undefined}
          className={cx(
            "relative flex h-row items-center gap-1.5 rounded pr-2 text-body whitespace-nowrap cursor-pointer",
            rowStateClass(isDragOver, isLocked, isSelected),
          )}
          style={{ paddingLeft: ROW_INSET_PX + depth * INDENT_PX }}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) {
              // Ctrl/Cmd+Click: toggle selection without toggling expand
              toggleSelectedEntry(node.id);
            } else {
              // Plain click: single select + toggle expand on any container
              setSelectedEntry(node.id);
              if (isExpandable) toggleFolder(node.id);
            }
          }}
          onDoubleClick={() => handleDoubleClick(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
          draggable={!isFlatMode}
          onDragStart={(e) => {
            // Determine items to drag
            let dragItems: Array<{ id: string; kind: string }>;

            if (selectedEntryIds.has(node.id) && selectedEntryIds.size > 1) {
              // Dragging a selected item from multi-selection: drag all selected
              const state = useEntryStore.getState();
              dragItems = [...selectedEntryIds].map((id) => {
                const folder = state.folders.find((f) => f.id === id);
                return { id, kind: folder ? "folder" : "entry" };
              });

              // Create drag image badge showing count
              const badge = document.createElement("div");
              badge.textContent = `${dragItems.length} items`;
              badge.style.cssText = "position:fixed;top:-100px;left:-100px;padding:4px 10px;border-radius:4px;background:var(--c-btn-primary-bg);color:white;font-size:12px;font-weight:600;white-space:nowrap;";
              document.body.appendChild(badge);
              e.dataTransfer.setDragImage(badge, 0, 0);
              requestAnimationFrame(() => document.body.removeChild(badge));
            } else {
              // Dragging unselected item or single item: drag just this, make it the selection
              dragItems = [{ id: node.id, kind: node.kind }];
              setSelectedEntry(node.id);
            }

            e.dataTransfer.setData("application/conduit-node", JSON.stringify(dragItems));
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            // Both folders and entries accept drops. Entries become parents
            // of nested entries (sets parent_entry_id); folders remain folders.
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverFolderId(node.id);
          }}
          onDragLeave={(e) => {
            // Only clear if leaving this node (not entering a child)
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverFolderId((prev) => (prev === node.id ? null : prev));
            }
          }}
          onDrop={(e) => {
            handleDrop(e, node.id);
          }}
        >
          <IndentGuides depth={depth} />
          {isExpandable ? (
            <button
              type="button"
              data-cv-tree-twistie=""
              aria-label={isExpanded ? "Collapse" : "Expand"}
              title={isExpanded ? "Collapse" : "Expand"}
              className="flex size-4 shrink-0 items-center justify-center text-ink-muted"
            >
              {isExpanded ? (
                <ChevronDownIcon size={16} />
              ) : (
                <ChevronRightIcon size={16} />
              )}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <Icon size={16} className={`flex-shrink-0 ${colorResult.className ?? ""}`} style={colorResult.style} />
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="h-5 min-w-0 flex-1 rounded-[2px] border border-(--c-focus) bg-input px-1 text-body text-ink outline-hidden"
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
            <span className="flex items-center gap-1">
              {node.name}
              {vaultType === "personal" && <ConflictDot tbl={isFolder ? 2 : 1} rowId={node.id} />}
              {isLocked && (
                <LockIcon size={12} className="text-ink-faint flex-shrink-0" />
              )}
              {isFolder && vaultType === "team" && (() => {
                const effectiveRole = getEffectiveRole(node.id);
                if (effectiveRole === "viewer") {
                  return <span title="View-only" className="flex shrink-0"><LockIcon size={12} className="text-warning" /></span>;
                }
                return null;
              })()}
              {!isFolder && !isLocked && favoriteIds.has(node.id) && (
                <StarFilledIcon size={12} className="text-favorite flex-shrink-0" />
              )}
            </span>
          )}
        </div>

        {isExpandable && isExpanded && node.children && node.children.length > 0 && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (tree.length === 0) {
    if (vaultType === "team" && !searchQuery && !showFavoritesOnly) {
      return (
        <div className="mt-8 text-center px-4">
          <UsersIcon size={32} className="text-ink-faint mx-auto mb-2" />
          <p className="text-body text-ink-muted">No entries in this vault yet</p>
          <p className="text-label text-ink-faint mt-1">
            Click + above to add your first connection or credential.
          </p>
        </div>
      );
    }
    return (
      <div className="mt-4 text-center text-body text-ink-faint">
        {searchQuery
          ? "No matching entries"
          : showFavoritesOnly
            ? "No favorites yet — right-click an entry to add one"
            : "No entries yet"}
      </div>
    );
  }

  return (
    <div
      className="group/tree py-1"
      onClick={(e) => {
        // Click on empty tree area: clear selection
        if (e.target === e.currentTarget) {
          clearSelection();
        }
      }}
    >
      {isFlatMode
        ? (tree as FolderGroup[]).map((group) => renderGroup(group))
        : (tree as TreeNode[]).map((node) => renderNode(node))}

      {/* Upgrade banner when at connection limit */}
      {maxConnections !== -1 && connectionCount >= maxConnections && authMode !== 'local' && (
        <div className="mx-2 mt-2">
          <UpgradeBanner
            message={`Connection limit reached (${connectionCount}/${maxConnections})`}
            ctaLabel="Upgrade to Pro"
            onCta={() => invoke('auth_open_pricing')}
          />
        </div>
      )}

      {/* Root drop zone: drop items here to move to root level */}
      {!isFlatMode && (
        <div
          className={cx(
            "h-6 mx-1 mt-1 rounded",
            dragOverRoot && "bg-(--c-drop-bg) border border-dashed border-accent",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverRoot(true);
          }}
          onDragLeave={() => setDragOverRoot(false)}
          onDrop={(e) => handleDrop(e, null)}
        />
      )}

      {deleteConfirm && (() => {
        let message: string;
        if (deleteConfirm.node.kind === "folder") {
          // Count all descendants (entries + subfolders) recursively
          const descendantFolderIds = new Set<string>();
          const collectDescendants = (parentId: string) => {
            for (const f of folders) {
              if (f.parent_id === parentId && !descendantFolderIds.has(f.id)) {
                descendantFolderIds.add(f.id);
                collectDescendants(f.id);
              }
            }
          };
          collectDescendants(deleteConfirm.node.id);
          const childEntryCount = entries.filter(
            (e) => e.folder_id === deleteConfirm.node.id || (e.folder_id && descendantFolderIds.has(e.folder_id))
          ).length;
          const totalItems = descendantFolderIds.size + childEntryCount;
          message = totalItems > 0
            ? `This folder contains ${totalItems} item${totalItems !== 1 ? "s" : ""}. Are you sure you want to delete "${deleteConfirm.node.name}" and all its contents?`
            : `Are you sure you want to delete the folder "${deleteConfirm.node.name}"?`;
        } else {
          message = `Are you sure you want to delete "${deleteConfirm.node.name}"?`;
        }
        return (
          <ConfirmDialog
            title={`Delete ${deleteConfirm.node.kind === "folder" ? "Folder" : "Entry"}`}
            message={message}
            confirmLabel="Delete"
            variant="danger"
            onConfirm={confirmDelete}
            onCancel={() => setDeleteConfirm(null)}
          />
        );
      })()}

      {multiDeleteConfirm && (
        <ConfirmDialog
          title="Delete Selected Items"
          message={`Are you sure you want to delete ${multiDeleteConfirm.count} selected items? This cannot be undone.`}
          confirmLabel={`Delete ${multiDeleteConfirm.count} Items`}
          variant="danger"
          onConfirm={confirmMultiDelete}
          onCancel={() => setMultiDeleteConfirm(null)}
        />
      )}

      {credPickerEntryId && (
        <CredentialPicker
          selectedId={null}
          onSelect={(credentialId) => {
            if (credentialId) {
              openEntryWithCredential(credPickerEntryId, credentialId);
            }
            setCredPickerEntryId(null);
          }}
          onClose={() => setCredPickerEntryId(null)}
        />
      )}
    </div>
  );
}
