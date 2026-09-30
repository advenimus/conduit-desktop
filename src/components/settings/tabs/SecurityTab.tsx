import { useState, useEffect, type ReactNode } from "react";
import { useVaultStore } from "../../../stores/vaultStore";
import { FingerprintIcon } from "../../../lib/icons";
import { Callout, Card, SectionHeader, Switch } from "../../ui";
import { HINT } from "../settings-styles";
import IdleLockSetting from "../../sync/IdleLockSetting";
import type { TabProps } from "../SettingsHelpers";
import { errorText } from "../../../lib/errorText";

export default function SecurityTab({ settings, setSettings }: TabProps) {
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
      setError(errorText(err, "Failed to update biometric setting"));
    } finally {
      setToggling(false);
    }
  };

  const isMac = navigator.userAgent.includes("Mac");
  const isTeamVault = vaultType === "team";

  return (
    <div className="space-y-6">
      {/* Quick Unlock: macOS only */}
      {isMac && (
        <div>
          <SectionHeader title="Quick Unlock" />
          {isTeamVault ? (
            <NoticeCard>
              <p className="text-body text-ink-muted">
                Quick Unlock is only available for personal vaults. Team vaults
                use key-based encryption and don't require a master password.
              </p>
            </NoticeCard>
          ) : !biometricAvailable ? (
            <NoticeCard>
              <div>
                <p className="text-body text-ink-muted">
                  Touch ID is not available on this Mac.
                </p>
                <p className={`mt-1 ${HINT}`}>
                  Requires a Mac with Touch ID or an Apple Watch paired for unlock.
                </p>
              </div>
            </NoticeCard>
          ) : !isUnlocked ? (
            <NoticeCard>
              <p className="text-body text-ink-muted">
                Unlock a personal vault first to manage Quick Unlock settings.
              </p>
            </NoticeCard>
          ) : (
            <div className="space-y-3">
              <Card className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <FingerprintIcon size={20} className={biometricEnabled ? "text-(--c-accent)" : "text-ink-faint"} />
                  <div>
                    <p className="text-body font-semibold text-ink">Quick Unlock</p>
                    <p className={`mt-0.5 ${HINT}`}>
                      {biometricEnabled
                        ? "Unlock this vault with Touch ID or Apple Watch"
                        : "Use Touch ID or Apple Watch to unlock this vault"}
                    </p>
                  </div>
                </div>
                <Switch checked={biometricEnabled} onChange={() => void handleToggle()} disabled={toggling} label="Quick Unlock" />
              </Card>

              {error && <Callout tone="danger">{error}</Callout>}

              <p className={`px-1 ${HINT}`}>
                Your master password is stored encrypted in the system keychain.
                Touch ID or Apple Watch authentication is required to access it.
                You can always use your master password as a fallback.
              </p>
            </div>
          )}
        </div>
      )}

      <div>
        <SectionHeader title="Auto-lock" />
        <IdleLockSetting
          minutes={settings.vault_idle_lock_minutes}
          onChange={(minutes) => setSettings((prev) => ({ ...prev, vault_idle_lock_minutes: minutes }))}
        />
      </div>
    </div>
  );
}

function NoticeCard({ children }: { children: ReactNode }) {
  return (
    <Card className="flex items-start gap-3">
      <FingerprintIcon size={20} className="mt-0.5 shrink-0 text-ink-faint" />
      {children}
    </Card>
  );
}
