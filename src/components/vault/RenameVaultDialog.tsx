import { useState } from "react";
import { invoke } from "../../lib/electron";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore } from "../../stores/teamStore";
import { toast } from "../common/Toast";
import { AlertCircleIcon, LoaderIcon, PencilIcon } from "../../lib/icons";

interface RenameVaultDialogProps {
  onClose: () => void;
}

export default function RenameVaultDialog({ onClose }: RenameVaultDialogProps) {
  const { currentVaultPath, vaultType, teamVaultId } = useVaultStore();
  const { teamVaults } = useTeamStore();

  const isTeamVault = vaultType === "team";

  const currentName = isTeamVault
    ? teamVaults.find((v) => v.id === teamVaultId)?.name ?? ""
    : currentVaultPath
        ?.split(/[/\\]/)
        .pop()
        ?.replace(/\.conduit$/i, "") ?? "";

  const [newName, setNewName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = newName.trim().length > 0 && newName.trim() !== currentName;

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError(null);

    try {
      if (isTeamVault && teamVaultId) {
        await invoke("team_vault_rename", {
          teamVaultId,
          newName: newName.trim(),
        });
        await useTeamStore.getState().loadTeamVaults();
      } else {
        const newPath = await invoke<string>("vault_rename", {
          newName: newName.trim(),
        });
        const settings = await invoke<{ recent_vaults?: string[] }>(
          "settings_get",
        );
        useVaultStore.setState({
          currentVaultPath: newPath,
          recentVaults: settings.recent_vaults ?? [],
        });
      }

      toast.success(`Vault renamed to "${newName.trim()}"`);
      onClose();
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to rename vault");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[400px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <PencilIcon size={20} className="text-conduit-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-ink">Rename Vault</h2>
            <p className="text-xs text-ink-muted">
              Change the display name of this vault
            </p>
          </div>
        </div>

        <form onSubmit={handleRename} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1.5">
              Vault Name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setError(null);
              }}
              placeholder="Enter new vault name"
              className="w-full px-3 py-2 rounded-md bg-well border border-stroke text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500/50"
              autoFocus
            />
            {!isTeamVault && (
              <p className="text-xs text-ink-faint mt-1.5">
                File will be renamed to &ldquo;{newName.trim() || "..."}.conduit&rdquo;
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon
                size={16}
                className="text-red-400 mt-0.5 flex-shrink-0"
              />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-md hover:bg-raised transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || loading}
              className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading && <LoaderIcon size={14} className="animate-spin" />}
              Rename
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
