import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import RecoveryPassphraseDialog from "./RecoveryPassphraseDialog";
import { CheckIcon, DesktopIcon, KeyIcon, type IconComponent } from "../../lib/icons";
import { Button, Callout, Dialog, Spinner, TextInput } from "../ui";
import { errorText } from "../../lib/errorText";

interface DeviceSetupDialogProps {
  onComplete: () => void;
  onSkip: () => void;
}

type SetupMode =
  | "loading"          // Checking if user has existing backup
  | "first-time"       // No backup → generate new identity key
  | "generating"       // Key generation in progress
  | "show-passphrase"  // Show recovery passphrase after generation
  | "choose"           // Has backup → choose recovery method
  | "passphrase"       // Enter recovery passphrase
  | "device-auth"      // Request device authorization
  | "waiting"          // Waiting for device auth approval
  | "success"          // Setup complete
  | "error";           // Error occurred

/**
 * Smart device setup dialog for team vault access.
 *
 * Behavior:
 * - First-time user (no backup exists): generates identity key, shows passphrase
 * - Returning user (backup exists): offers recovery via passphrase or device auth
 *
 * Triggered on-demand when user tries to create/open a team vault, not on app launch.
 */
export default function DeviceSetupDialog({
  onComplete,
  onSkip,
}: DeviceSetupDialogProps) {
  const [mode, setMode] = useState<SetupMode>("loading");
  const [passphrase, setPassphrase] = useState("");
  const [generatedPassphrase, setGeneratedPassphrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollTimer, setPollTimer] = useState<ReturnType<typeof setInterval> | null>(null);
  // Tracks mode before error so "Back" returns to the right screen
  const [errorReturnMode, setErrorReturnMode] = useState<SetupMode>("first-time");

  // On mount, check if user has an existing key backup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hasBackup = await invoke<boolean>("identity_key_has_backup");
        if (cancelled) return;
        setMode(hasBackup ? "choose" : "first-time");
      } catch {
        if (!cancelled) setMode("first-time");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Clean up poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [pollTimer]);

  const handleGenerateKey = async () => {
    setMode("generating");
    setError(null);
    try {
      const result = await invoke<{ recoveryPassphrase: string }>("identity_key_generate");
      setGeneratedPassphrase(result.recoveryPassphrase);
      setMode("show-passphrase");
    } catch (err) {
      setError(errorText(err, "Failed to generate identity key"));
      setErrorReturnMode("first-time");
      setMode("error");
    }
  };

  const handlePassphraseSaved = () => {
    setGeneratedPassphrase(null);
    setMode("success");
    setTimeout(onComplete, 1500);
  };

  const handleRecoverWithPassphrase = async () => {
    if (!passphrase.trim()) return;

    setLoading(true);
    setError(null);
    try {
      await invoke("identity_key_recover", { passphrase: passphrase.trim() });
      setMode("success");
      setTimeout(onComplete, 1500);
    } catch (err) {
      setError(
        errorText(err, "Invalid recovery passphrase")
      );
      setErrorReturnMode("choose");
      setMode("error");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestDeviceAuth = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ requestId: string }>("device_auth_request");
      setMode("waiting");

      // Poll for approval
      const timer = setInterval(async () => {
        try {
          const status = await invoke<{ status: string; success?: boolean }>(
            "device_auth_check",
            { requestId: result.requestId }
          );

          if (status.status === "approved") {
            clearInterval(timer);
            setPollTimer(null);
            setMode("success");
            setTimeout(onComplete, 1500);
          } else if (status.status === "denied" || status.status === "expired") {
            clearInterval(timer);
            setPollTimer(null);
            setError(
              status.status === "denied"
                ? "Request was denied by the other device"
                : "Request expired. Please try again."
            );
            setErrorReturnMode("choose");
            setMode("error");
          }
        } catch {
          // Polling error — keep trying
        }
      }, 3000);

      setPollTimer(timer);
    } catch (err) {
      setError(
        errorText(err, "Failed to create auth request")
      );
      setErrorReturnMode("choose");
      setMode("error");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      setPollTimer(null);
    }
    setMode("choose");
    setError(null);
  };

  const handleErrorBack = () => {
    setError(null);
    setMode(errorReturnMode);
  };

  // Recovery passphrase display (after first-time key generation)
  if (mode === "show-passphrase" && generatedPassphrase) {
    return (
      <RecoveryPassphraseDialog
        passphrase={generatedPassphrase}
        onConfirm={handlePassphraseSaved}
      />
    );
  }

  const skip = (
    <Button variant="ghost" onClick={onSkip}>
      Skip for now
    </Button>
  );

  const footer =
    mode === "first-time" ? (
      <>
        {skip}
        <Button variant="primary" onClick={handleGenerateKey}>
          Generate Identity Key
        </Button>
      </>
    ) : mode === "choose" ? (
      skip
    ) : mode === "passphrase" ? (
      <>
        <Button onClick={handleCancel}>Back</Button>
        <Button variant="primary" onClick={handleRecoverWithPassphrase} disabled={!passphrase.trim()} loading={loading}>
          Recover
        </Button>
      </>
    ) : mode === "error" ? (
      <>
        <Button onClick={handleErrorBack}>Back</Button>
        {skip}
      </>
    ) : undefined;

  return (
    <Dialog open title="Set Up Team Access" icon="devices" width={440} hideClose closeOnEscape={false} onClose={onSkip} footer={footer}>
      <p className="-mt-2 pl-9 text-label text-ink-muted">Configure this device for team vaults</p>

      {mode === "loading" && (
        <div className="flex items-center justify-center py-8">
          <Spinner size={24} className="text-ink-muted" />
        </div>
      )}

      {mode === "first-time" && (
        <Callout tone="info" icon="shieldCheck" title="Identity Key Required">
          Team vaults use zero-knowledge encryption. An identity key will
          be generated for this device and a recovery passphrase will be
          provided for backup.
        </Callout>
      )}

      {mode === "generating" && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Spinner size={24} className="text-ink-muted" />
          <p className="text-body text-ink">Generating identity key...</p>
        </div>
      )}

      {mode === "choose" && (
        <>
          <p className="text-body text-ink-secondary">
            An identity key was previously set up on another device. Choose how
            to recover it:
          </p>
          <RecoveryOption
            icon={KeyIcon}
            title="Enter Recovery Passphrase"
            description="Use your 6-word recovery passphrase"
            onClick={() => setMode("passphrase")}
          />
          <RecoveryOption
            icon={DesktopIcon}
            title="Authorize From Existing Device"
            description="Approve access from a device you already use"
            onClick={handleRequestDeviceAuth}
            disabled={loading}
          />
        </>
      )}

      {mode === "passphrase" && (
        <>
          <p className="text-body text-ink-secondary">
            Enter the 6-word recovery passphrase you saved when setting up
            your first device.
          </p>
          <TextInput
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="word1 word2 word3 word4 word5 word6"
            className="font-mono"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRecoverWithPassphrase();
            }}
          />
        </>
      )}

      {mode === "waiting" && (
        <div className="flex flex-col items-center gap-4 py-6">
          <Spinner size={24} className="text-ink-muted" />
          <div className="text-center">
            <p className="text-body text-ink">Waiting for approval...</p>
            <p className="mt-1 text-label text-ink-muted">
              Open Conduit on your existing device and approve the request
            </p>
          </div>
          <Button onClick={handleCancel}>Cancel</Button>
        </div>
      )}

      {mode === "success" && (
        <div className="flex flex-col items-center gap-4 py-6">
          <div className="flex size-12 items-center justify-center rounded-full bg-success-bg">
            <CheckIcon size={24} className="text-success" />
          </div>
          <p className="text-body text-ink">Device set up successfully!</p>
        </div>
      )}

      {mode === "error" && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function RecoveryOption({
  icon: Icon,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: IconComponent;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-3 rounded-md border border-card-border p-3 text-left transition-colors hover:border-(--c-control-border) hover:bg-hover disabled:opacity-40"
    >
      <Icon size={20} className="shrink-0 text-ink-muted transition-colors group-hover:text-ink" />
      <span className="min-w-0">
        <span className="block text-body font-medium text-ink">{title}</span>
        <span className="block text-label text-ink-muted">{description}</span>
      </span>
    </button>
  );
}
