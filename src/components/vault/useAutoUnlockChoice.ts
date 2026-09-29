import { useEffect, useState } from "react";
import { useStartupVaultStore } from "../../stores/startupVaultStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useSyncStore } from "../../stores/syncStore";
import { errorText } from "../../lib/errorText";
import { toast } from "../common/Toast";
import { toastAutoUnlockOff, toastResealed, vaultName } from "../../lib/startup-vault-copy";

interface ChoiceInput {
  readonly isInitializing: boolean;
  /** A Touch ID prompt is running, or the one the dialog starts by itself has not finished. */
  readonly touchIdPending: boolean;
}

export interface AutoUnlockChoice {
  /** The unlock dialog shows the checkbox (spec 2.1). */
  readonly showCheckbox: boolean;
  /** Stale or unreadable saved unlock: the "Keep unlocking" form of the checkbox, checked at first. */
  readonly keepMode: boolean;
  readonly checked: boolean;
  setChecked(checked: boolean): void;
  /** The line under the file name after a lock of a vault with a saved unlock. */
  readonly afterLockLine: string | null;
  /** After a successful unlock: "warning" swaps the dialog to the warning, "done" closes it. */
  afterUnlock(): Promise<"warning" | "done">;
  /** "Keep unlocking automatically" from the password-changed dialog of an automatic attempt. */
  afterSavedPasswordChanged(keep: boolean): Promise<void>;
}

async function reseal(): Promise<void> {
  try {
    await useStartupVaultStore.getState().enable({ kind: "recent-unlock" });
    toastResealed();
  } catch (err) {
    toast.warning("Couldn't update the saved unlock", errorText(err, "Conduit will ask for the password at the next start."));
  }
}

async function keepOff(name: string, unreadable: boolean): Promise<void> {
  try {
    if (unreadable) await useStartupVaultStore.getState().disable();
    toastAutoUnlockOff(name);
  } catch (err) {
    toast.error("Couldn't turn off automatic unlock", errorText(err, "Try again in Settings > Security."));
  }
}

/** The automatic-unlock part of the unlock dialog (docs/AUTO_UNLOCK.md 2.1), kept out of UnlockDialog.tsx. */
export function useAutoUnlockChoice({ isInitializing, touchIdPending }: ChoiceInput): AutoUnlockChoice {
  const status = useStartupVaultStore((s) => s.status);
  const fallback = useStartupVaultStore((s) => s.fallback);
  const currentVaultPath = useVaultStore((s) => s.currentVaultPath);
  const vaultType = useVaultStore((s) => s.vaultType);
  const biometricOn = useVaultStore((s) => s.biometricAvailable && s.biometricEnabled);
  const takeoverMode = useSyncStore((s) => s.takeoverMode);
  const keepMode = fallback?.kind === "stale" || fallback?.kind === "unreadable";
  const [checked, setChecked] = useState(keepMode);

  useEffect(() => {
    void useStartupVaultStore.getState().refresh();
  }, [currentVaultPath]);

  useEffect(() => {
    setChecked(keepMode);
  }, [keepMode]);

  const savedHere = status?.savedPath != null && status.savedPath === currentVaultPath;
  const offerable = !isInitializing && vaultType === "personal" && Boolean(status?.store.usable) && !takeoverMode;
  const showCheckbox = offerable && (keepMode || (!savedHere && !touchIdPending && fallback === null));
  const afterLockLine =
    savedHere && fallback === null && !isInitializing
      ? `Automatic unlock runs when Conduit starts. Enter your master password${biometricOn ? " or use Quick Unlock" : ""}.`
      : null;

  const afterUnlock = async (): Promise<"warning" | "done"> => {
    if (keepMode && fallback) {
      if (checked) await reseal();
      else await keepOff(fallback.name, fallback.kind === "unreadable");
      return "done";
    }
    return showCheckbox && checked ? "warning" : "done";
  };

  const afterSavedPasswordChanged = async (keep: boolean): Promise<void> => {
    if (keep) await reseal();
    else toastAutoUnlockOff(fallback?.name ?? vaultName(currentVaultPath ?? ""));
  };

  return { showCheckbox, keepMode, checked, setChecked, afterLockLine, afterUnlock, afterSavedPasswordChanged };
}
