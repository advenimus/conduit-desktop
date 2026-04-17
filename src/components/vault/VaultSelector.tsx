import { useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { showContextMenu } from "../../utils/contextMenu";
import { CloseIcon, FolderOpenIcon, LockIcon, PlusIcon } from "../../lib/icons";

interface VaultSelectorProps {
  onClose: () => void;
  onVaultReady: () => void;
}

export default function VaultSelector({ onClose, onVaultReady }: VaultSelectorProps) {
  const { createVault, openVault, pickVaultFile, recentVaults, isLoading, error, clearError, removeRecentVault, clearRecentVaults } = useVaultStore();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [step, setStep] = useState<"choose" | "password">("choose");
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const handleCreateNew = async () => {
    clearError();
    const filePath = await pickVaultFile("save");
    if (!filePath) return;
    setPendingPath(filePath);
    setStep("password");
  };

  const handleOpenExisting = async () => {
    clearError();
    const filePath = await pickVaultFile("open");
    if (!filePath) return;
    try {
      await openVault(filePath);
      onVaultReady();
    } catch {
      // Error set in store
    }
  };

  const handleOpenRecent = async (filePath: string) => {
    clearError();
    try {
      await openVault(filePath);
      onVaultReady();
    } catch {
      // Error set in store
    }
  };

  const handleRecentVaultContextMenu = async (e: React.MouseEvent, vaultPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    const selected = await showContextMenu(e.clientX, e.clientY, [
      { id: "remove", label: "Remove from Recents", icon: "close" },
      { id: "sep", label: "", type: "separator" },
      { id: "copy", label: "Copy Path", icon: "copy" },
    ]);
    if (selected === "remove") {
      await removeRecentVault(vaultPath);
    } else if (selected === "copy") {
      await navigator.clipboard.writeText(vaultPath);
    }
  };

  const handleCreateWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingPath || !newPassword || newPassword !== confirmPassword) return;
    clearError();
    try {
      await createVault(pendingPath, newPassword);
      onVaultReady();
    } catch {
      // Error set in store
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div data-dialog-content className="w-full max-w-md bg-panel rounded-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-stroke">
          <div className="flex items-center gap-2">
            <LockIcon size={20} className="text-conduit-400" />
            <h2 className="text-lg font-semibold">
              {step === "choose" ? "Select Vault" : "Set Password"}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-raised">
            <CloseIcon size={18} />
          </button>
        </div>

        {step === "choose" && (
          <div className="p-4 space-y-3">
            <button
              onClick={handleCreateNew}
              disabled={isLoading}
              className="flex items-center gap-3 w-full p-4 bg-raised/50 hover:bg-raised rounded-lg transition-colors"
            >
              <PlusIcon size={20} className="text-conduit-400" />
              <div className="text-left">
                <div className="text-sm font-medium">Create New Vault</div>
                <div className="text-xs text-ink-muted">Start with a fresh .conduit file</div>
              </div>
            </button>

            <button
              onClick={handleOpenExisting}
              disabled={isLoading}
              className="flex items-center gap-3 w-full p-4 bg-raised/50 hover:bg-raised rounded-lg transition-colors"
            >
              <FolderOpenIcon size={20} className="text-ink-muted" />
              <div className="text-left">
                <div className="text-sm font-medium">Open Existing Vault</div>
                <div className="text-xs text-ink-muted">Browse for a .conduit file</div>
              </div>
            </button>

            {recentVaults.length > 0 && (
              <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-ink-muted uppercase">Recent Vaults</h3>
                  <button
                    onClick={() => clearRecentVaults()}
                    className="text-[11px] text-ink-faint hover:text-ink-muted transition-colors"
                  >
                    Clear All
                  </button>
                </div>
                <div className="space-y-1">
                  {recentVaults.map((vaultPath) => (
                    <button
                      key={vaultPath}
                      onClick={() => handleOpenRecent(vaultPath)}
                      onContextMenu={(e) => handleRecentVaultContextMenu(e, vaultPath)}
                      disabled={isLoading}
                      className="w-full text-left px-3 py-2 text-sm text-ink-secondary hover:bg-raised rounded truncate"
                      title={vaultPath}
                    >
                      {vaultPath.split(/[/\\]/).pop()}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>
        )}

        {step === "password" && (
          <form onSubmit={handleCreateWithPassword} className="p-4 space-y-3">
            <p className="text-sm text-ink-muted truncate" title={pendingPath ?? ""}>
              {pendingPath?.split(/[/\\]/).pop()}
            </p>

            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">Master Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Choose a strong password"
                autoFocus
                className="w-full px-3 py-2 bg-well border border-stroke rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                className={`w-full px-3 py-2 bg-well border rounded text-sm focus:outline-none focus:ring-2 focus:ring-conduit-500 ${
                  confirmPassword && newPassword !== confirmPassword
                    ? "border-red-500"
                    : "border-stroke"
                }`}
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-red-400 mt-1">Passwords do not match</p>
              )}
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep("choose")}
                className="px-4 py-2 text-sm hover:bg-raised rounded"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!newPassword || newPassword !== confirmPassword || isLoading}
                className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
              >
                {isLoading ? "Creating..." : "Create Vault"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
