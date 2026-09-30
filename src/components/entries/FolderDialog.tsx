import { useState, useEffect } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { getEntryIcon, getEntryColor } from "./entryIcons";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, TextInput } from "../ui";
import AppearancePickers from "./AppearancePickers";
import Field from "./Field";
import { VaultContextStrip, ViewOnlyNotice } from "./VaultContextStrip";

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const vaultType = useVaultStore((s) => s.vaultType);
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

  const handleSubmit = async () => {
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const saved = isEditing
        ? await updateFolder(editingFolderId!, { name: name.trim(), icon: customIcon, color: customColor })
        : await createFolder(name.trim(), parentId, customIcon, customColor);
      // The store showed why; keep the dialog open.
      if (!saved) return;
      onClose();
    } catch (err) {
      console.error(`Failed to ${isEditing ? "update" : "create"} folder:`, err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const FolderIcon = getEntryIcon("folder", false, customIcon);
  const colorResult = getEntryColor("folder", customColor);

  const title = isEditing ? "Edit Folder" : "New Folder";

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={384}
      closeOnEscape={false}
      layout="custom"
      onSubmit={() => void handleSubmit()}
    >
      <DialogHeader
        title={
          <span className="flex items-center gap-2">
            <FolderIcon size={20} className={colorResult.className} style={colorResult.style} />
            {title}
          </span>
        }
      />
      <VaultContextStrip />
      {isViewerInTeamVault && <ViewOnlyNotice />}

      <DialogBody className="py-4">
        <Field label="Folder Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="My Servers" autoFocus />
        </Field>
        <Field label="Appearance" group>
          <AppearancePickers
            Icon={FolderIcon}
            colorResult={colorResult}
            customIcon={customIcon}
            setCustomIcon={setCustomIcon}
            customColor={customColor}
            setCustomColor={setCustomColor}
            iconLabels={["Default", "Custom"]}
            colorLabels={["Default", "Custom"]}
          />
        </Field>
      </DialogBody>

      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim() || isViewerInTeamVault}
          loading={isSubmitting}
          loadingLabel={isEditing ? "Saving..." : "Creating..."}
        >
          {isEditing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
