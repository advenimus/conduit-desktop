import { useState, useEffect } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import ProVaultLockDialog from "./ProVaultLockDialog";
import { AlertCircleIcon, LoaderIcon, LockIcon } from "../../lib/icons";

interface TeamVaultUnlockProps {
  teamVaultId: string;
  vaultName: string;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Team vault unlock dialog. No password prompt — VEK is unwrapped
 * automatically using the user's identity key. Shows a connecting
 * spinner while opening.
 */
export default function TeamVaultUnlock({
  teamVaultId,
  vaultName,
  onSuccess,
  onCancel,
}: TeamVaultUnlockProps) {
  const { openTeamVault } = useVaultStore();
  const [status, setStatus] = useState<"connecting" | "error" | "locked">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lockInfo, setLockInfo] = useState<{ lockedByEmail: string; lockedAt: string } | null>(null);

  const handleOpenError = (err: unknown) => {
    const errStr = typeof err === "string" ? err : err instanceof Error ? err.message : "";
    // Check for structured vault lock error
    try {
      const parsed = JSON.parse(errStr);
      if (parsed.type === "VAULT_LOCKED") {
        setLockInfo({ lockedByEmail: parsed.lockedByEmail, lockedAt: parsed.lockedAt });
        setStatus("locked");
        return;
      }
    } catch { /* not JSON, fall through */ }
    setStatus("error");
    setError(errStr || "Failed to connect to team vault");
  };

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        await openTeamVault(teamVaultId);
        if (!cancelled) {
          onSuccess();
        }
      } catch (err) {
        if (!cancelled) {
          handleOpenError(err);
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
    };
  }, [teamVaultId]);

  const handleRetry = () => {
    setStatus("connecting");
    setError(null);
    setLockInfo(null);
    openTeamVault(teamVaultId)
      .then(() => onSuccess())
      .catch(handleOpenError);
  };

  // When vault is locked by another user, show ProVaultLockDialog instead
  if (status === "locked" && lockInfo) {
    return (
      <ProVaultLockDialog
        lockedByEmail={lockInfo.lockedByEmail}
        lockedAt={lockInfo.lockedAt}
        onRetry={handleRetry}
        onUpgrade={() => window.electron.invoke("auth_open_account")}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-panel border border-stroke rounded-lg shadow-xl w-[400px] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <LockIcon size={20} className="text-conduit-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-ink">
              Team Vault
            </h2>
            <p className="text-sm text-ink-secondary">
              {vaultName}
            </p>
          </div>
        </div>

        {status === "connecting" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
            <div className="text-center">
              <p className="text-sm text-ink">
                Connecting to team vault...
              </p>
              <p className="text-xs text-ink-muted mt-1">
                Decrypting vault key with your identity
              </p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRetry}
                className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {status === "connecting" && (
          <div className="flex justify-end mt-4">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
