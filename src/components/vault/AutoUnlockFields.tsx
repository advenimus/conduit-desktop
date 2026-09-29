import { useStartupVaultStore } from "../../stores/startupVaultStore";
import { Button, Callout, Checkbox } from "../ui";

/** The note that replaces the status line when the saved unlock did not work (docs/AUTO_UNLOCK.md 2.1). */
export function AutoUnlockFallbackNote({ onTurnOff }: { onTurnOff: () => void }) {
  const fallback = useStartupVaultStore((s) => s.fallback);
  const storeName = useStartupVaultStore((s) => s.status?.store.storeName ?? "system keychain");
  if (fallback?.kind === "stale") {
    return (
      <Callout tone="warning">
        Conduit couldn't open {fallback.name} automatically. The master password may have changed on another device. Enter it to open the vault.
      </Callout>
    );
  }
  if (fallback?.kind === "unreadable") {
    return (
      <Callout
        tone="warning"
        actions={
          <Button variant="link" size="sm" onClick={onTurnOff}>
            Turn Off Automatic Unlock
          </Button>
        }
      >
        Conduit couldn't read the saved unlock from the {storeName}. Enter your master password.
      </Callout>
    );
  }
  return null;
}

interface AutoUnlockCheckboxProps {
  keepMode: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function AutoUnlockCheckbox({ keepMode, checked, onChange }: AutoUnlockCheckboxProps) {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      description={keepMode ? "Saves the password you enter now." : "Opens this vault when Conduit starts, without the password."}
    >
      <span className="font-medium text-ink">{keepMode ? "Keep unlocking automatically at startup" : "Unlock automatically at startup"}</span>
    </Checkbox>
  );
}
