import { useEffect, useState, type ReactNode } from "react";
import { useStartupVaultStore, type StartupStatus } from "../../../stores/startupVaultStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { AUTO_UNLOCK_SHORT_WARNING, toastAutoUnlockOff, vaultName } from "../../../lib/startup-vault-copy";
import { errorText } from "../../../lib/errorText";
import AutoUnlockWarningDialog from "../../vault/AutoUnlockWarningDialog";
import { Button, Callout, Card, IconSlot, SectionHeader, Switch, cx } from "../../ui";
import { HINT } from "../settings-styles";

interface AutoUnlockSettingProps {
  /** The Security tab's NoticeCard, with its icon. */
  notice: (children: ReactNode) => ReactNode;
}

function unusableText(status: StartupStatus): string {
  if (status.store.reason === "weak") {
    return "Automatic unlock needs a system keyring, such as GNOME Keyring or KWallet. Conduit can't find one, so it can't keep your password safe on this computer.";
  }
  if (status.platform === "win32") return "Automatic unlock needs the system credential store, and it isn't available on this computer.";
  return "Automatic unlock needs the system keychain, and it isn't available on this computer.";
}

/** Settings > Security > Automatic Unlock (docs/AUTO_UNLOCK.md 2.5). */
export default function AutoUnlockSetting({ notice }: AutoUnlockSettingProps) {
  const status = useStartupVaultStore((s) => s.status);
  const { vaultType, currentVaultPath } = useVaultStore();
  const [showWarning, setShowWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useStartupVaultStore.getState().refresh();
  }, []);

  const turnOff = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await useStartupVaultStore.getState().disable();
      toastAutoUnlockOff(name);
    } catch (err) {
      setError(errorText(err, "Couldn't turn off automatic unlock"));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;
  const name = vaultName(currentVaultPath ?? "");
  const savedName = status.savedPath ? vaultName(status.savedPath) : null;

  const body = (() => {
    if (vaultType === "team") {
      return notice(
        <div>
          <p className="text-body text-ink-muted">Automatic unlock is for personal vaults. Team vaults already open without a password on this computer.</p>
          {savedName && (
            <p className={`mt-1 ${HINT}`}>
              {savedName} unlocks automatically on this computer.{" "}
              <Button variant="link" size="sm" onClick={() => void turnOff(savedName)} disabled={busy}>
                Turn Off
              </Button>
            </p>
          )}
        </div>,
      );
    }
    if (!status.store.usable) return notice(<p className="text-body text-ink-muted">{unusableText(status)}</p>);
    const on = status.currentOn;
    return (
      <div className="space-y-3">
        <Card className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <IconSlot icon="lockOpen" size={20} className={cx("shrink-0", on ? "text-(--c-accent)" : "text-ink-faint")} />
            <div className="min-w-0">
              <p className="text-body font-semibold text-ink">Unlock automatically at startup</p>
              <p className={`mt-0.5 ${HINT}`}>
                {on ? `${name} opens without the master password when Conduit starts` : `Open ${name} without the master password when Conduit starts`}
              </p>
              {!on && savedName && (
                <p className={`mt-0.5 ${HINT}`}>
                  {savedName} unlocks automatically now. Turning this on moves it to {name}.
                </p>
              )}
            </div>
          </div>
          <Switch
            checked={on}
            onChange={(next) => (next ? setShowWarning(true) : void turnOff(name))}
            disabled={busy}
            label="Unlock automatically at startup"
          />
        </Card>
        {error && <Callout tone="danger">{error}</Callout>}
        {on && (
          <>
            <Callout tone="warning">{AUTO_UNLOCK_SHORT_WARNING}</Callout>
            <p className={HINT}>Your master password is kept in the {status.store.storeName} on this computer.</p>
          </>
        )}
      </div>
    );
  })();

  return (
    <div>
      <SectionHeader title="Automatic Unlock" />
      {body}
      {showWarning && <AutoUnlockWarningDialog mode="settings" layer="stacked" onClose={() => setShowWarning(false)} />}
    </div>
  );
}
