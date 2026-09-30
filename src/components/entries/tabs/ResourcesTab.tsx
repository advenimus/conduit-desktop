import type { RdpEntryConfig, SharedFolder, RdpGlobalDefaults } from "../../../types/entry";
import { SOUND_OPTIONS } from "../../../lib/sessionOptions";
import { invoke } from "../../../lib/electron";
import DefaultableSelect from "../DefaultableSelect";
import DefaultableCheckbox from "../DefaultableCheckbox";
import Field, { FIELD_LABEL_TEXT } from "../Field";
import { toast } from "../../common/Toast";
import { FolderIcon } from "../../../lib/icons";
import { Button, IconButton, TextInput } from "../../ui";

interface ResourcesTabProps {
  config: Partial<RdpEntryConfig>;
  onChange: (config: Partial<RdpEntryConfig>) => void;
  globalDefaults: RdpGlobalDefaults;
}

export default function ResourcesTab({ config, onChange, globalDefaults }: ResourcesTabProps) {
  const update = (partial: Partial<RdpEntryConfig>) => {
    onChange({ ...config, ...partial });
  };

  const sharedFolders = config.sharedFolders ?? [];

  const addSharedFolder = async () => {
    try {
      const result = await invoke<string | null>("dialog_select_folder");
      if (!result) return;
      const name = result.split(/[\\/]/).filter(Boolean).pop() || "share";
      const folders = [...sharedFolders, { name, path: result, readOnly: false }];
      update({ sharedFolders: folders });
    } catch (err) {
      console.error("Failed to pick a shared folder:", err);
      toast.error("Could not open the folder picker");
    }
  };

  const updateSharedFolder = (index: number, partial: Partial<SharedFolder>) => {
    const folders = [...sharedFolders];
    folders[index] = { ...folders[index], ...partial };
    update({ sharedFolders: folders });
  };

  const removeSharedFolder = (index: number) => {
    const folders = sharedFolders.filter((_, i) => i !== index);
    update({ sharedFolders: folders });
  };

  return (
    <div className="space-y-3">
      {/* Sound */}
      <Field label="Sound">
        <DefaultableSelect<string>
          value={config.sound}
          defaultLabel={SOUND_OPTIONS.find((o) => o.value === globalDefaults.sound)?.label ?? "Play locally"}
          options={SOUND_OPTIONS}
          onChange={(v) => update({ sound: v as "local" | "remote" | "none" })}
        />
      </Field>

      {/* Clipboard */}
      <DefaultableCheckbox
        value={config.clipboard}
        defaultValue={globalDefaults.clipboard}
        label="Clipboard Sharing"
        onChange={(v) => update({ clipboard: v })}
      />

      {/* Shared Folders: per-entry only, no "Default" option */}
      <div className="mt-3 border-t border-divider pt-3">
        <div className="mb-2 flex items-center justify-between">
          <label className={FIELD_LABEL_TEXT}>Shared Folders</label>
          <Button variant="link" size="sm" icon="plus" onClick={addSharedFolder}>
            Add Folder
          </Button>
        </div>

        {sharedFolders.length === 0 ? (
          <p className="text-meta text-ink-muted">No shared folders. Add a local folder to make it accessible in the remote session.</p>
        ) : (
          <div className="space-y-2">
            {sharedFolders.map((folder, i) => (
              <div key={i} className="flex items-center gap-2">
                <FolderIcon size={16} className="shrink-0 text-ink-muted" />
                <div className="w-28 shrink-0">
                  <TextInput
                    value={folder.name}
                    onChange={(e) => updateSharedFolder(i, { name: e.target.value })}
                    placeholder="Share name"
                  />
                </div>
                <span className="flex-1 truncate text-meta text-ink-muted" title={folder.path}>
                  {folder.path}
                </span>
                <IconButton
                  size="sm"
                  tone="inherit"
                  icon={folder.readOnly ? "lock" : "lockOpen"}
                  label={folder.readOnly ? "Read-only (click to allow writes)" : "Read/Write (click to make read-only)"}
                  onClick={() => updateSharedFolder(i, { readOnly: !folder.readOnly })}
                  className={folder.readOnly ? "text-warning" : "text-success"}
                />
                <IconButton size="sm" tone="danger" icon="trash" label="Remove shared folder" onClick={() => removeSharedFolder(i)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
