import { useState, useEffect, useRef } from "react";
import { useVaultStore, type UnlockOptions } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore } from "../../stores/aiStore";
import { useSyncStore } from "../../stores/syncStore";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/sync-api";
import { toast } from "../common/Toast";
import UnlockErrorView, { openErrorLine, type UnlockRetry } from "../sync/UnlockErrorView";
import { useForgetUnlockRequestOnClose } from "../sync/useForgetUnlockRequest";
import BiometricSetupPrompt from "./BiometricSetupPrompt";
import { CloudIcon, EyeIcon, EyeOffIcon, FingerprintIcon, LockIcon } from "../../lib/icons";

type AttemptKind = "password" | "biometric";

interface UnlockDialogProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export default function UnlockDialog({ onSuccess, onCancel }: UnlockDialogProps) {
  const {
    vaultExists,
    currentVaultPath,
    initializeVault,
    unlockVault,
    enableCloudSync,
    isLoading,
    error,
    clearError,
    biometricAvailable,
    biometricEnabled,
    biometricUnlockInProgress,
    biometricUnlock,
    enableBiometric,
    checkBiometric,
  } = useVaultStore();
  const { isAuthenticated } = useAuthStore();
  const cloudBackupAllowed = useAiStore((s) => s.tierCapabilities?.cloud_sync_enabled ?? false);
  const openError = useSyncStore((s) => s.openError);
  const takeoverMode = useSyncStore((s) => s.takeoverMode);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(true);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const biometricTriggered = useRef(false);
  const attemptRef = useRef<AttemptKind>("password");
  const lastOptsRef = useRef<UnlockOptions>({});

  const isInitializing = !vaultExists;

  // Structured errors without a dialog become the error line.
  useEffect(() => {
    if (!openError) return;
    const line = openErrorLine(openError);
    if (line) {
      setLineError(line);
      useSyncStore.getState().setOpenError(null);
    }
  }, [openError]);

  useForgetUnlockRequestOnClose();

  const runUnlock = async (kind: AttemptKind, pw: string, opts: UnlockOptions) => {
    attemptRef.current = kind;
    lastOptsRef.current = opts;
    const merged: UnlockOptions = useSyncStore.getState().takeoverMode ? { ...opts, takeover: true } : opts;
    if (kind === "biometric") await biometricUnlock(merged);
    else await unlockVault(pw, merged);
  };

  // Auto-trigger biometric on mount when available and enabled
  useEffect(() => {
    if (
      !isInitializing &&
      biometricAvailable &&
      biometricEnabled &&
      !biometricTriggered.current
    ) {
      biometricTriggered.current = true;
      handleBiometricUnlock();
    }
    // eslint-disable-next-line
  }, [biometricAvailable, biometricEnabled, isInitializing]);

  // Re-check biometric status when dialog opens
  useEffect(() => {
    checkBiometric();
    // eslint-disable-next-line
  }, []);

  const handleBiometricUnlock = async () => {
    clearError();
    setLineError(null);
    try {
      await runUnlock("biometric", "", {});
      onSuccess();
    } catch {
      // Cancelled or failed: stay on the dialog (sync errors open their own dialog)
    }
  };

  const offerBiometricSetup = async (): Promise<boolean> => {
    try {
      const [available, shouldPrompt] = await Promise.all([
        invoke<boolean>("biometric_available"),
        invoke<boolean>("biometric_should_prompt"),
      ]);
      if (available && shouldPrompt) {
        setShowBiometricSetup(true);
        return true;
      }
    } catch {
      // Check failed: skip the setup prompt
    }
    return false;
  };

  const handleRetry = async (retry: UnlockRetry) => {
    const previousError = useSyncStore.getState().openError;
    setRetrying(true);
    setRetryError(null);
    try {
      if (retry.password !== null) setPassword(retry.password);
      const kind: AttemptKind = retry.password !== null ? "password" : attemptRef.current;
      // A take-over or rebuild repeats the last attempt, keeping its previous password.
      const opts = retry.password !== null ? retry.opts : { ...lastOptsRef.current, ...retry.opts };
      await runUnlock(kind, retry.password ?? password, opts);
      if (kind === "password" && (await offerBiometricSetup())) return;
      onSuccess();
    } catch {
      const sync = useSyncStore.getState();
      if (sync.openError === null && previousError?.code === "VAULT_PASSWORD_CHANGED_ELSEWHERE") {
        sync.setOpenError(previousError);
        setRetryError(useVaultStore.getState().error ?? "That password didn't work.");
      }
    } finally {
      setRetrying(false);
    }
  };

  const handleErrorCancel = () => {
    useSyncStore.getState().setOpenError(null);
    setPassword("");
    setRetryError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLineError(null);

    if (isInitializing && password !== confirmPassword) {
      return;
    }

    try {
      if (isInitializing) {
        await initializeVault(password);
        if (cloudBackup && showCloudBackupOption) {
          try {
            await enableCloudSync();
          } catch (err) {
            console.error("[vault] Failed to enable cloud backup:", err);
            toast.error("Could not turn on cloud backup", errorText(err, "Try again in Settings > Backup."));
          }
        }
      } else {
        await runUnlock("password", password, {});
        if (await offerBiometricSetup()) return;
      }

      onSuccess();
    } catch {
      // Error is set in the store
    }
  };

  const handleBiometricSetupAccept = async () => {
    try {
      await enableBiometric();
    } catch (err) {
      console.error("Failed to enable biometric:", err);
    }
    onSuccess();
  };

  const handleBiometricSetupDismiss = async () => {
    // Mark prompt as dismissed for this specific vault
    try {
      await invoke("biometric_dismiss_prompt");
    } catch {
      // Best-effort
    }
    onSuccess();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (showBiometricSetup) {
        handleBiometricSetupDismiss();
      } else {
        onCancel();
      }
    }
  };

  const passwordsMatch = !isInitializing || password === confirmPassword;
  const canSubmit = password.length > 0 && passwordsMatch && !isLoading && !biometricUnlockInProgress;
  const showCloudBackupOption = isAuthenticated && cloudBackupAllowed;
  const shownError = lineError ?? error;

  if (openError && !openErrorLine(openError)) {
    return (
      <UnlockErrorView
        payload={openError}
        busy={retrying || isLoading || biometricUnlockInProgress}
        error={retryError}
        onRetry={(retry) => void handleRetry(retry)}
        onCancel={handleErrorCancel}
      />
    );
  }

  // Biometric setup prompt (shown after first successful password unlock)
  if (showBiometricSetup) {
    return (
      <BiometricSetupPrompt
        onKeyDown={handleKeyDown}
        onDismiss={handleBiometricSetupDismiss}
        onAccept={handleBiometricSetupAccept}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
    >
      <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl">
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="flex flex-col items-center pt-6 pb-2 px-4">
            <div className="w-12 h-12 bg-conduit-600/20 rounded-full flex items-center justify-center mb-3">
              <LockIcon size={24} className="text-conduit-400" />
            </div>
            <h2 className="text-lg font-semibold">
              {isInitializing ? "Create Vault" : "Unlock Vault"}
            </h2>
            {currentVaultPath && (
              <p className="text-xs text-ink-faint mt-1 truncate max-w-[280px]" title={currentVaultPath}>
                {currentVaultPath.split(/[/\\]/).pop()}
              </p>
            )}
            <p className="text-sm text-ink-muted mt-1 text-center">
              {isInitializing
                ? "Set a master password to protect your credentials"
                : biometricUnlockInProgress
                ? "Authenticating..."
                : takeoverMode
                ? "Unlock to use this vault here. It locks on the other device."
                : "Enter your master password to access credentials"}
            </p>
          </div>

          {/* Content */}
          <div className="p-4 space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                Master Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter master password"
                  autoFocus={!biometricEnabled}
                  disabled={biometricUnlockInProgress}
                  className="w-full px-3 py-2 pr-10 bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 disabled:opacity-50"
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
            </div>

            {/* Biometric unlock button */}
            {!isInitializing && biometricAvailable && biometricEnabled && (
              <button
                type="button"
                onClick={handleBiometricUnlock}
                disabled={biometricUnlockInProgress}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium border border-stroke rounded hover:bg-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <FingerprintIcon size={18} className="text-conduit-400" />
                {biometricUnlockInProgress ? "Authenticating..." : "Quick Unlock"}
              </button>
            )}

            {isInitializing && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Confirm Password
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm master password"
                    className={`w-full px-3 py-2 bg-well border rounded focus:outline-none focus:ring-2 focus:ring-conduit-500 ${
                      confirmPassword && !passwordsMatch
                        ? "border-red-500"
                        : "border-stroke"
                    }`}
                  />
                  {confirmPassword && !passwordsMatch && (
                    <p className="text-xs text-red-400 mt-1">
                      Passwords do not match
                    </p>
                  )}
                </div>
                {showCloudBackupOption && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cloudBackup}
                      onChange={(e) => setCloudBackup(e.target.checked)}
                      className="mt-0.5 accent-conduit-500"
                    />
                    <div>
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <CloudIcon size={14} className="text-conduit-400" />
                        Back up to the cloud
                      </div>
                      <p className="text-xs text-ink-muted mt-0.5">
                        End-to-end encrypted with AES-256-GCM. Your master password never leaves this device.
                      </p>
                    </div>
                  </label>
                )}
              </>
            )}

            {shownError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{shownError}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-stroke">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm hover:bg-raised rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
            >
              {isLoading
                ? "Please wait..."
                : isInitializing
                ? "Create Vault"
                : "Unlock"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
