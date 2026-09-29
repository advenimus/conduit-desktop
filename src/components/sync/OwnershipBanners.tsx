import { useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { useSyncStore } from "../../stores/syncStore";
import { useVaultStore } from "../../stores/vaultStore";
import type { VaultOwnership } from "../../types/sync";
import SyncBanner from "./SyncBanner";
import { makeOwnCopyWhileOpen, openTeamTrial, switchAccount, updateConduit } from "./plan-actions";
import { formatShortDate, releaseAfterText } from "./sync-copy";

const DISMISS_KEY_PREFIX = "conduit.ownershipBanner";

function closeVault(): void {
  document.dispatchEvent(new CustomEvent("conduit:lock-vault"));
}

/** S21: soft-locked because another account owns the vault. */
export function NotOwnerLockBanner() {
  return (
    <SyncBanner
      tone="lock"
      text="This vault belongs to another Conduit account. Your open connections keep running."
      actions={[{ label: "Close vault", onClick: closeVault }]}
    />
  );
}

/** S22: soft-locked until the app is updated. */
export function UpdateRequiredLockBanner() {
  return (
    <SyncBanner
      tone="lock"
      text="Update Conduit to use this vault. Your open connections keep running."
      actions={[
        { label: "Update Conduit", primary: true, onClick: () => void updateConduit() },
        { label: "Close vault", onClick: closeVault },
      ]}
    />
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Hidden with [Later] for the rest of the day, per vault and banner (a local UI flag only). */
function useDismissedToday(kind: string, lineageId: string): readonly [boolean, () => void] {
  const key = `${DISMISS_KEY_PREFIX}.${kind}.${lineageId}`;
  const read = (): boolean => {
    try {
      return window.localStorage.getItem(key) === today();
    } catch {
      return false;
    }
  };
  const [dismissed, setDismissed] = useState(read);
  const dismiss = () => {
    try {
      window.localStorage.setItem(key, today());
    } catch {
      // Storage off: the banner hides until the next render of the app only.
    }
    setDismissed(true);
  };
  return [dismissed, dismiss] as const;
}

/** S7: open during another account's grace. */
function GraceBanner({ lineageId, untilMs, canCopy }: { lineageId: string; untilMs: number; canCopy: boolean }) {
  const email = useAuthStore((s) => s.user?.email ?? null);
  const vaultPath = useVaultStore((s) => s.currentVaultPath);
  const [dismissed, dismiss] = useDismissedToday("grace", lineageId);
  if (dismissed) return null;
  const signedIn = email === null ? "" : ` Signed in as ${email}.`;
  return (
    <SyncBanner
      tone="warn"
      text={`This vault belongs to another Conduit account. You can use it until ${formatShortDate(untilMs)}. The owner can move it into a Team vault and invite you.${signedIn}`}
      actions={[
        { label: "Switch account", onClick: () => void switchAccount() },
        { label: "Later", onClick: dismiss },
        { label: "Try Team free", onClick: openTeamTrial },
        // A private vault has no working copy to fork while open.
        ...(canCopy ? [{ label: "Make my own copy", primary: true, onClick: () => void makeOwnCopyWhileOpen(vaultPath) }] : []),
      ]}
    />
  );
}

/** S7b: the owner sees another account using the vault. */
function SharedBanner({ lineageId, ownership }: { lineageId: string; ownership: Extract<VaultOwnership, { kind: "owner" }> }) {
  const [dismissed, dismiss] = useDismissedToday("shared", lineageId);
  if (dismissed || ownership.sharedUntilMs === null) return null;
  const tooSoon = ownership.releaseAfterMs !== null && ownership.releaseAfterMs > Date.now();
  return (
    <SyncBanner
      tone="info"
      text={`Another Conduit account is using this vault until ${formatShortDate(ownership.sharedUntilMs)}.${tooSoon && ownership.releaseAfterMs !== null ? ` ${releaseAfterText(ownership.releaseAfterMs)}` : ""}`}
      actions={[
        { label: "Later", onClick: dismiss },
        { label: "Try Team free", onClick: openTeamTrial },
        { label: "Release this vault...", primary: true, disabled: tooSoon, onClick: () => useSyncStore.getState().setReleaseDialogOpen(true) },
      ]}
    />
  );
}

/** The grace (S7) or shared (S7b) banner of the open personal vault, or nothing. */
export function OwnershipBanner() {
  const state = useSyncStore((s) => s.state);
  const isUnlocked = useVaultStore((s) => s.isUnlocked);
  const vaultType = useVaultStore((s) => s.vaultType);
  const ownership = state?.ownership ?? null;
  const lineageId = state?.vault?.lineageId ?? null;
  if (!isUnlocked || vaultType !== "personal" || ownership === null || lineageId === null) return null;
  if (ownership.kind === "grace") {
    return <GraceBanner key={lineageId} lineageId={lineageId} untilMs={ownership.untilMs} canCopy={state?.vault?.engine === true} />;
  }
  if (ownership.kind === "owner" && ownership.sharedUntilMs !== null && ownership.sharedUntilMs > Date.now()) {
    return <SharedBanner key={lineageId} lineageId={lineageId} ownership={ownership} />;
  }
  return null;
}
