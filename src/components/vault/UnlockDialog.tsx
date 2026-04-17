import { useState, useEffect, useRef } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { invoke } from "../../lib/electron";
import { CloudIcon, EyeIcon, EyeOffIcon, FingerprintIcon, LockIcon } from "../../lib/icons";

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
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cloudBackup, setCloudBackup] = useState(true);
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);
  const biometricTriggered = useRef(false);

  const isInitializing = !vaultExists;

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
    try {
      await biometricUnlock();
      onSuccess();
    } catch {
      // User cancelled or biometric failed — stay on dialog
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (isInitializing && password !== confirmPassword) {
      return;
    }

    try {
      if (isInitializing) {
        await initializeVault(password);
        if (cloudBackup && isAuthenticated) {
          try {
            await enableCloudSync();
          } catch (err) {
            console.error("Failed to enable cloud sync:", err);
          }
        }
      } else {
        await unlockVault(password);
      }

      // After successful password unlock, check if we should offer biometric setup
      if (!isInitializing) {
        try {
          const [available, shouldPrompt] = await Promise.all([
            invoke<boolean>("biometric_available"),
            invoke<boolean>("biometric_should_prompt"),
          ]);
          if (available && shouldPrompt) {
            setShowBiometricSetup(true);
            return; // Don't call onSuccess yet — show setup prompt
          }
        } catch {
          // Check failed — skip setup prompt
        }
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

  // Biometric setup prompt (shown after first successful password unlock)
  if (showBiometricSetup) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
        onKeyDown={handleKeyDown}
      >
        <div data-dialog-content className="w-full max-w-sm bg-panel rounded-lg shadow-xl">
          <div className="flex flex-col items-center pt-6 pb-2 px-4">
            <div className="w-12 h-12 bg-conduit-600/20 rounded-full flex items-center justify-center mb-3">
              <FingerprintIcon size={24} className="text-conduit-400" />
            </div>
            <h2 className="text-lg font-semibold">Enable Quick Unlock</h2>
            <p className="text-sm text-ink-muted mt-2 text-center">
              Unlock this vault faster next time with Touch ID, Apple Watch, or your system password.
            </p>
          </div>

          <div className="flex justify-end gap-2 px-4 py-4 border-t border-stroke mt-2">
            <button
              type="button"
              onClick={handleBiometricSetupDismiss}
              className="px-4 py-2 text-sm hover:bg-raised rounded"
            >
              Not Now
            </button>
            <button
              type="button"
              onClick={handleBiometricSetupAccept}
              className="px-4 py-2 text-sm text-white bg-conduit-600 hover:bg-conduit-700 rounded"
            >
              Enable
            </button>
          </div>
        </div>
      </div>
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
                {isAuthenticated && (
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

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded">
                <p className="text-sm text-red-400">{error}</p>
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
