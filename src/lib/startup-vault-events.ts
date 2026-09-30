// Main's auto-unlock-event (electron/ipc/auto-unlock-lifecycle.ts) as toasts (docs/AUTO_UNLOCK.md 2.8).
import { toast } from "../components/common/Toast";
import { useStartupVaultStore } from "../stores/startupVaultStore";
import { useVaultStore } from "../stores/vaultStore";
import { toastAccountChanged, toastResealFailed, toastResealed } from "./startup-vault-copy";

type AutoUnlockEvent =
  | { readonly kind: "forgotten"; readonly reason: "sign-out" | "account" | "release" | "own-copy"; readonly name: string | null }
  | { readonly kind: "resealed"; readonly name: string }
  | { readonly kind: "reseal-failed"; readonly name: string };

function isEvent(payload: unknown): payload is AutoUnlockEvent {
  return typeof payload === "object" && payload !== null && typeof (payload as { kind?: unknown }).kind === "string";
}

function toastForgotten(reason: string, name: string | null): void {
  if (reason === "sign-out") toast.info("Automatic unlock is off", "Signing out turns it off on this computer.");
  else if (reason === "account") toastAccountChanged();
  else if (reason === "release") toast.info("Automatic unlock is off", `${name ?? "This vault"} is no longer yours to open at startup.`);
  else if (reason === "own-copy") toast.info("Automatic unlock is off", "Your copy opens at startup. Turn automatic unlock on again from the unlock screen.");
}

export function handleAutoUnlockEvent(payload: unknown): void {
  if (!isEvent(payload)) return;
  if (payload.kind === "resealed") toastResealed();
  else if (payload.kind === "reseal-failed") toastResealFailed();
  else toastForgotten(payload.reason, payload.name);
  void useStartupVaultStore.getState().refresh();
}

/** Main reports currentOn only while the vault is unlocked, so every unlock and lock re-reads it (spec 2.7). */
export function watchVaultForStartupStatus(): () => void {
  return useVaultStore.subscribe((s, prev) => {
    if (s.isUnlocked !== prev.isUnlocked || s.currentVaultPath !== prev.currentVaultPath || s.vaultType !== prev.vaultType) {
      void useStartupVaultStore.getState().refresh();
    }
  });
}
