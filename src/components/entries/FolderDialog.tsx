import { useState, useEffect, useRef } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { getEntryIcon, getEntryColor } from "./entryIcons";
import IconPicker from "./IconPicker";
import ColorPicker from "./ColorPicker";
import {
  CloseIcon, IconsIcon, LockIcon, PaletteIcon, UsersIcon
} from "../../lib/icons";

interface FolderDialogProps {
  onClose: () => void;
  parentId?: string | null;
  editingFolderId?: string | null;
}

export default function FolderDialog({ onClose, parentId, editingFolderId }: FolderDialogProps) {
  const { folders, createFolder, updateFolder } = useEntryStore();
  const isEditing = !!editingFolderId;

  const [name, setName] = useState("");
  const [customIcon, setCustomIcon] = useState<string | null>(null);
  const [customColor, setCustomColor] = useState<string | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const iconBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const vaultType = useVaultStore((s) => s.vaultType);
  const teamVaultId = useVaultStore((s) => s.teamVaultId);
  const teamVaults = useTeamStore((s) => s.teamVaults);
  const teamVaultName = teamVaults.find((v) => v.id === teamVaultId)?.name;
  const currentVaultPath = useVaultStore((s) => s.currentVaultPath);
  const getEffectiveRole = useTeamStore((s) => s.getEffectiveRole);

  // For new folders, check parent. For editing, check the folder itself.
  const checkFolderId = editingFolderId ?? parentId;
  const isViewerInTeamVault = vaultType === "team" && getEffectiveRole(checkFolderId ?? undefined) === "viewer";

  // Load folder data when editing
  useEffect(() => {
    if (!editingFolderId) return;
    const folder = folders.find((f) => f.id === editingFolderId);
    if (folder) {
      setName(folder.name);
      setCustomIcon(folder.icon ?? null);
      setCustomColor(folder.color ?? null);
    }
  }, [editingFolderId, folders]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      if (isEditing) {
        await updateFolder(editingFolderId!, { name: name.trim(), icon: customIcon, color: customColor });
      } else {
        await createFolder(name.trim(), parentId, customIcon, customColor);
      }
      onClose();
    } catch (err) {
      console.error(`Failed to ${isEditing ? "update" : "create"} folder:`, err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const FolderIcon = getEntryIcon("folder", false, customIcon);
  const colorResult = getEntryColor("folder", customColor);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl">
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-stroke">
            <div className="flex items-center gap-2">
              <FolderIcon size={20} className={colorResult.className} style={colorResult.style} />
              <h2 className="text-lg font-semibold">{isEditing ? "Edit Folder" : "New Folder"}</h2>
            </div>
            <button type="button" onClick={onClose} className="p-1 rounded hover:bg-raised">
              <CloseIcon size={18} />
            </button>
          </div>

          {/* Vault context */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-stroke text-xs">
            {vaultType === "team" ? (
              <>
                <UsersIcon size={14} className="text-conduit-400" />
                <span className="text-ink-muted">Saving to:</span>
                <span className="text-ink font-medium">{teamVaultName ?? "Team Vault"}</span>
                <span className="px-1.5 py-0.5 bg-conduit-500/10 text-conduit-400 rounded text-[10px]">Team</span>
              </>
            ) : (
              <>
                <LockIcon size={14} className="text-ink-faint" />
                <span className="text-ink-muted">Saving to:</span>
                <span className="text-ink font-medium">{currentVaultPath?.split(/[/\\]/).pop() ?? "Personal Vault"}</span>
              </>
            )}
          </div>

          {/* Viewer warning */}
          {isViewerInTeamVault && (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400">
              <LockIcon size={14} />
              <span>You have view-only access to this folder</span>
            </div>
          )}

          {/* Content */}
          <div className="p-4 space-y-3">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">
                Folder Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Servers"
                autoFocus
                className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
            </div>

            {/* Appearance */}
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">Appearance</label>
              <div className="flex items-center gap-3">
                {/* Preview */}
                <div className="w-9 h-9 flex items-center justify-center bg-well rounded border border-stroke">
                  <FolderIcon size={20} className={colorResult.className} style={colorResult.style} />
                </div>

                {/* Icon picker */}
                <button
                  ref={iconBtnRef}
                  type="button"
                  onClick={() => { setShowIconPicker(!showIconPicker); setShowColorPicker(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-stroke rounded hover:bg-raised transition-colors"
                >
                  <IconsIcon size={14} />
                  {customIcon ? "Custom" : "Default"}
                </button>
                {showIconPicker && (
                  <IconPicker
                    value={customIcon}
                    onSelect={setCustomIcon}
                    onClose={() => setShowIconPicker(false)}
                    customColor={customColor}
                    anchorRef={iconBtnRef}
                  />
                )}

                {/* Color picker */}
                <button
                  ref={colorBtnRef}
                  type="button"
                  onClick={() => { setShowColorPicker(!showColorPicker); setShowIconPicker(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-stroke rounded hover:bg-raised transition-colors"
                >
                  {customColor ? (
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: customColor }} />
                  ) : (
                    <PaletteIcon size={14} />
                  )}
                  {customColor ? "Custom" : "Default"}
                </button>
                {showColorPicker && (
                  <ColorPicker
                    value={customColor}
                    onSelect={setCustomColor}
                    onClose={() => setShowColorPicker(false)}
                    anchorRef={colorBtnRef}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm hover:bg-raised rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isSubmitting || isViewerInTeamVault}
              className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
            >
              {isSubmitting
                ? isEditing ? "Saving..." : "Creating..."
                : isEditing ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
