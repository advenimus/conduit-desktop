import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import RecoveryPassphraseDialog from "./RecoveryPassphraseDialog";
import {
  AlertCircleIcon, CheckIcon, DesktopIcon, DevicesIcon, KeyIcon, LoaderIcon, ShieldCheckIcon
} from "../../lib/icons";

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
      setError(err instanceof Error ? err.message : "Failed to generate identity key");
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
        err instanceof Error ? err.message : "Invalid recovery passphrase"
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
        err instanceof Error ? err.message : "Failed to create auth request"
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[440px] p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-conduit-500/10 flex items-center justify-center">
            <DevicesIcon size={20} className="text-conduit-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-ink">
              Set Up Team Access
            </h2>
            <p className="text-xs text-ink-muted">
              Configure this device for team vaults
            </p>
          </div>
        </div>

        {/* Loading — checking backup status */}
        {mode === "loading" && (
          <div className="flex items-center justify-center py-8">
            <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
          </div>
        )}

        {/* First-time setup — no backup exists, generate new key */}
        {mode === "first-time" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-conduit-500/5 border border-conduit-500/20">
              <ShieldCheckIcon size={20} className="text-conduit-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-ink">Identity Key Required</p>
                <p className="text-xs text-ink-muted mt-1">
                  Team vaults use zero-knowledge encryption. An identity key will
                  be generated for this device and a recovery passphrase will be
                  provided for backup.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={onSkip}
                className="px-4 py-2 text-sm text-ink-muted hover:text-ink-secondary transition-colors"
              >
                Skip for now
              </button>
              <button
                onClick={handleGenerateKey}
                className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors flex items-center gap-1.5"
              >
                Generate Identity Key
              </button>
            </div>
          </div>
        )}

        {/* Generating key spinner */}
        {mode === "generating" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
            <p className="text-sm text-ink">Generating identity key...</p>
          </div>
        )}

        {/* Choose recovery method — backup exists */}
        {mode === "choose" && (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary mb-4">
              An identity key was previously set up on another device. Choose how
              to recover it:
            </p>

            <button
              onClick={() => setMode("passphrase")}
              className="w-full p-4 rounded-lg border border-stroke hover:border-conduit-500/50 hover:bg-well transition-colors text-left group"
            >
              <div className="flex items-center gap-3">
                <KeyIcon
                  size={20}
                  className="text-ink-muted group-hover:text-conduit-400 transition-colors"
                />
                <div>
                  <p className="text-sm font-medium text-ink">
                    Enter Recovery Passphrase
                  </p>
                  <p className="text-xs text-ink-muted">
                    Use your 6-word recovery passphrase
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={handleRequestDeviceAuth}
              disabled={loading}
              className="w-full p-4 rounded-lg border border-stroke hover:border-conduit-500/50 hover:bg-well transition-colors text-left group disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <DesktopIcon
                  size={20}
                  className="text-ink-muted group-hover:text-conduit-400 transition-colors"
                />
                <div>
                  <p className="text-sm font-medium text-ink">
                    Authorize From Existing Device
                  </p>
                  <p className="text-xs text-ink-muted">
                    Approve access from a device you already use
                  </p>
                </div>
              </div>
            </button>

            <div className="flex justify-end pt-2">
              <button
                onClick={onSkip}
                className="text-sm text-ink-muted hover:text-ink-secondary transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Passphrase entry */}
        {mode === "passphrase" && (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              Enter the 6-word recovery passphrase you saved when setting up
              your first device.
            </p>

            <input
              type="text"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="word1 word2 word3 word4 word5 word6"
              className="w-full px-3 py-2 rounded-md bg-well border border-stroke text-ink placeholder:text-ink-faint text-sm font-mono focus:outline-none focus:border-conduit-500/50"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRecoverWithPassphrase();
              }}
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleRecoverWithPassphrase}
                disabled={loading || !passphrase.trim()}
                className="px-4 py-2 text-sm bg-conduit-600 text-white rounded-md hover:bg-conduit-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {loading && <LoaderIcon size={14} className="animate-spin" />}
                Recover
              </button>
            </div>
          </div>
        )}

        {/* Waiting for device authorization */}
        {mode === "waiting" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
            <div className="text-center">
              <p className="text-sm text-ink">
                Waiting for approval...
              </p>
              <p className="text-xs text-ink-muted mt-1">
                Open Conduit on your existing device and approve the request
              </p>
            </div>
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors mt-2"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Success */}
        {mode === "success" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckIcon size={24} className="text-green-400" />
            </div>
            <p className="text-sm text-ink">
              Device set up successfully!
            </p>
          </div>
        )}

        {/* Error */}
        {mode === "error" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon
                size={16}
                className="text-red-400 mt-0.5 flex-shrink-0"
              />
              <p className="text-sm text-red-300">{error}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleErrorBack}
                className="px-4 py-2 text-sm text-ink-secondary hover:text-ink rounded-md hover:bg-well transition-colors"
              >
                Back
              </button>
              <button
                onClick={onSkip}
                className="px-4 py-2 text-sm text-ink-muted hover:text-ink-secondary transition-colors"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
