import type { RdpEntryConfig, SharedFolder, RdpGlobalDefaults } from "../../../types/entry";
import { SOUND_OPTIONS } from "../../../lib/sessionOptions";
import { invoke } from "../../../lib/electron";
import DefaultableSelect from "../DefaultableSelect";
import DefaultableCheckbox from "../DefaultableCheckbox";
import Field from "../Field";
import {
  FolderIcon, LockIcon, LockOpenIcon, PlusIcon, TrashIcon
} from "../../../lib/icons";

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
    } catch {
      // User cancelled or error
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

      {/* Shared Folders — per-entry only, no "Default" option */}
      <div className="border-t border-stroke pt-3 mt-3">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-ink-secondary">Shared Folders</label>
          <button
            type="button"
            onClick={addSharedFolder}
            className="flex items-center gap-1 text-xs text-conduit-400 hover:text-conduit-300 px-2 py-1 rounded hover:bg-raised"
          >
            <PlusIcon size={14} />
            Add Folder
          </button>
        </div>

        {sharedFolders.length === 0 ? (
          <p className="text-xs text-ink-faint">No shared folders. Add a local folder to make it accessible in the remote session.</p>
        ) : (
          <div className="space-y-2">
            {sharedFolders.map((folder, i) => (
              <div key={i} className="flex items-center gap-2">
                <FolderIcon size={14} className="text-ink-muted flex-shrink-0" />
                <input
                  type="text"
                  value={folder.name}
                  onChange={(e) => updateSharedFolder(i, { name: e.target.value })}
                  placeholder="Share name"
                  className="w-28 px-2 py-1 bg-well border border-stroke rounded text-xs focus:outline-none focus:ring-2 focus:ring-conduit-500"
                />
                <span className="text-xs text-ink-faint truncate flex-1" title={folder.path}>
                  {folder.path}
                </span>
                <button
                  type="button"
                  onClick={() => updateSharedFolder(i, { readOnly: !folder.readOnly })}
                  className={`p-1 rounded hover:bg-raised flex-shrink-0 ${
                    folder.readOnly ? "text-yellow-500" : "text-green-500"
                  }`}
                  title={folder.readOnly ? "Read-only (click to allow writes)" : "Read/Write (click to make read-only)"}
                >
                  {folder.readOnly
                    ? <LockIcon size={14} />
                    : <LockOpenIcon size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => removeSharedFolder(i)}
                  className="p-1 text-ink-faint hover:text-red-400 rounded hover:bg-raised flex-shrink-0"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
