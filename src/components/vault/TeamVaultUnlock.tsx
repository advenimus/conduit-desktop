import { useState, useEffect } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import ProVaultLockDialog from "./ProVaultLockDialog";
import { Button, Callout, Dialog, Spinner } from "../ui";

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

  const footer =
    status === "error" ? (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={handleRetry}>
          Try Again
        </Button>
      </>
    ) : status === "connecting" ? (
      <Button onClick={onCancel}>Cancel</Button>
    ) : undefined;

  return (
    <Dialog open title="Team Vault" icon="lock" width={400} hideClose closeOnEscape={false} onClose={onCancel} footer={footer}>
      <p className="-mt-2 pl-9 text-body text-ink-secondary">{vaultName}</p>

      {status === "connecting" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Spinner size={24} className="text-ink-muted" />
          <div className="text-center">
            <p className="text-body text-ink">Connecting to team vault...</p>
            <p className="mt-1 text-label text-ink-muted">Decrypting vault key with your identity</p>
          </div>
        </div>
      )}

      {status === "error" && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
