import { useState, useEffect } from "react";
import { useVaultStore } from "../../../stores/vaultStore";
import { FingerprintIcon, AlertCircleIcon } from "../../../lib/icons";

export default function SecurityTab() {
  const {
    biometricAvailable,
    biometricEnabled,
    enableBiometric,
    disableBiometric,
    checkBiometric,
    isUnlocked,
    vaultType,
  } = useVaultStore();

  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkBiometric();
  }, [checkBiometric]);

  const handleToggle = async () => {
    setToggling(true);
    setError(null);
    try {
      if (biometricEnabled) {
        await disableBiometric();
      } else {
        await enableBiometric();
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "Failed to update biometric setting");
    } finally {
      setToggling(false);
    }
  };

  const isMac = navigator.userAgent.includes("Mac");
  const isTeamVault = vaultType === "team";

  return (
    <div className="space-y-6">
      {/* Quick Unlock — macOS only */}
      {isMac && (
        <div>
          <h3 className="text-sm font-semibold text-ink mb-3">Quick Unlock</h3>

          {isTeamVault ? (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-well border border-stroke-dim">
              <FingerprintIcon size={20} className="text-ink-faint mt-0.5 flex-shrink-0" />
              <p className="text-sm text-ink-muted">
                Quick Unlock is only available for personal vaults. Team vaults
                use key-based encryption and don't require a master password.
              </p>
            </div>
          ) : !biometricAvailable ? (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-well border border-stroke-dim">
              <FingerprintIcon size={20} className="text-ink-faint mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-ink-muted">
                  Touch ID is not available on this Mac.
                </p>
                <p className="text-xs text-ink-faint mt-1">
                  Requires a Mac with Touch ID or an Apple Watch paired for unlock.
                </p>
              </div>
            </div>
          ) : !isUnlocked ? (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-well border border-stroke-dim">
              <FingerprintIcon size={20} className="text-ink-faint mt-0.5 flex-shrink-0" />
              <p className="text-sm text-ink-muted">
                Unlock a personal vault first to manage Quick Unlock settings.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-well border border-stroke-dim">
                <div className="flex items-center gap-3">
                  <FingerprintIcon
                    size={20}
                    className={biometricEnabled ? "text-conduit-400" : "text-ink-faint"}
                  />
                  <div>
                    <p className="text-sm font-medium text-ink">
                      Quick Unlock
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {biometricEnabled
                        ? "Unlock this vault with Touch ID or Apple Watch"
                        : "Use Touch ID or Apple Watch to unlock this vault"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleToggle}
                  disabled={toggling}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    biometricEnabled ? "bg-conduit-500" : "bg-ink-faint/30"
                  } ${toggling ? "opacity-50" : ""}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      biometricEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20">
                  <AlertCircleIcon size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <p className="text-xs text-ink-faint px-1">
                Your master password is stored encrypted in the system keychain.
                Touch ID or Apple Watch authentication is required to access it.
                You can always use your master password as a fallback.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Non-macOS placeholder */}
      {!isMac && (
        <div>
          <h3 className="text-sm font-semibold text-ink mb-3">Security</h3>
          <p className="text-sm text-ink-muted">
            No additional security settings are available for this platform yet.
          </p>
        </div>
      )}
    </div>
  );
}
