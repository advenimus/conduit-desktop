import { useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import {
  CloudDownloadIcon, EyeIcon, EyeOffIcon, KeyIcon, LockIcon, ServerIcon, ShieldIcon
} from "../../lib/icons";

interface CloudRestoreDialogProps {
  onRestore: () => void;
  onCreateNew: () => void;
}

export default function CloudRestoreDialog({
  onRestore,
  onCreateNew,
}: CloudRestoreDialogProps) {
  const { restoreFromCloud, isLoading, error, clearError } = useVaultStore();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    try {
      await restoreFromCloud(password);
      onRestore();
    } catch {
      // Error is set in the store
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl">
        <form onSubmit={handleRestore}>
          {/* Header */}
          <div className="flex flex-col items-center pt-6 pb-2 px-4">
            <div className="w-12 h-12 bg-conduit-600/20 rounded-full flex items-center justify-center mb-3">
              <CloudDownloadIcon
                size={24}
                className="text-conduit-400"
              />
            </div>
            <h2 className="text-lg font-semibold">Welcome Back</h2>
            <p className="text-sm text-ink-muted mt-1 text-center">
              We found your encrypted vault backup
            </p>
          </div>

          {/* Trust badges */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <ShieldIcon size={14} className="text-green-400 flex-shrink-0" />
              <span>AES-256-GCM encrypted</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <LockIcon size={14} className="text-green-400 flex-shrink-0" />
              <span>Zero-knowledge — we cannot access your data</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <ServerIcon size={14} className="text-green-400 flex-shrink-0" />
              <span>Backed by enterprise-grade AWS infrastructure</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <KeyIcon size={14} className="text-green-400 flex-shrink-0" />
              <span>Your master password never leaves this device</span>
            </div>
          </div>

          {/* Password input */}
          <div className="px-4 pb-3">
            <label className="block text-sm font-medium mb-1">
              Master Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your master password"
                autoFocus
                className="w-full px-3 py-2 pr-10 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-muted hover:text-ink"
              >
                {showPassword ? (
                  <EyeOffIcon size={16} />
                ) : (
                  <EyeIcon size={16} />
                )}
              </button>
            </div>

            {error && (
              <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
            <button
              type="button"
              onClick={onCreateNew}
              className="px-4 py-2 text-sm hover:bg-raised rounded"
            >
              Create New Vault
            </button>
            <button
              type="submit"
              disabled={!password || isLoading}
              className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
            >
              {isLoading ? "Restoring..." : "Restore from Cloud"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
