import { invoke } from "../../lib/electron";
import { syncApi } from "../../lib/sync-api";
import { errorText } from "../../lib/errorText";
import { useAuthStore } from "../../stores/authStore";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import { offerOpenNewVault } from "./prompt-actions";
import { releaseAfterText } from "./sync-copy";

/** Actions of the plan enforcement dialogs and banners (docs/PLAN_ENFORCEMENT.md 4.6-4.8). */

export const COPY_READY_TITLE = "Your copy is ready.";

export function openTeamTrial(): void {
  syncApi.openTeamTrial().catch((err) => {
    console.error("[sync] Failed to open the Team trial page:", err);
    toast.error("Could not open the Team page");
  });
}

/** [Update Conduit]: check for an update; when none is found, the download page. */
export async function updateConduit(): Promise<void> {
  try {
    const found = await invoke<{ downloaded?: boolean } | null>("force_check_for_updates");
    if (found === null) {
      await invoke("auth_open_download");
      return;
    }
    if (found.downloaded) document.dispatchEvent(new CustomEvent("conduit:check-for-updates"));
  } catch (err) {
    console.error("[sync] Update check failed:", err);
    await invoke("auth_open_download").catch(() => toast.error("Could not open the download page"));
  }
}

/** [Sign in]: the same entry the account menu uses. */
export function signIn(): void {
  useAuthStore.getState().exitToSignIn();
}

/** [Switch account]: sign out, then the sign-in screen. */
export async function switchAccount(): Promise<void> {
  await useAuthStore.getState().signOut();
  useAuthStore.getState().exitToSignIn();
}

/** S12 confirmed: vault_owner_release, then S14, S13, S23 or a refreshed owner line. */
export async function releaseVault(): Promise<void> {
  try {
    const res = await syncApi.releaseOwnership();
    if (res.released) toast.success("Vault released. The next account that opens it becomes its owner.");
    else if (res.reason === "too_soon") toast.warning(releaseAfterText(res.retryAfterMs));
    else if (res.reason === "unconfirmed") toast.error("Could not release this vault. Check your connection and try again.");
  } catch (err) {
    console.error("[sync] Release failed:", err);
    toast.error("Could not release this vault. Check your connection and try again.");
  }
  await useSyncStore.getState().refresh();
}

/** S4 [Make my own copy]: asks where (the original's folder first), forks, then offers to open it (S15). True when made. */
export async function makeOwnCopy(ticket: string, copyDir: string | null): Promise<boolean> {
  try {
    const target = await syncApi.pickVaultFile("save", { defaultDir: copyDir });
    if (!target) return false;
    const made = await syncApi.makeOwnCopy(ticket, target);
    offerOpenNewVault(made.path, COPY_READY_TITLE);
    return true;
  } catch (err) {
    console.error("[sync] Make my own copy failed:", err);
    toast.error("Could not make your copy", errorText(err, "Try again."));
    return false;
  }
}

/** S7 [Make my own copy] while the vault is open: a separate vault from this device's copy. */
export async function makeOwnCopyWhileOpen(vaultPath: string | null): Promise<void> {
  try {
    const dir = vaultPath === null ? null : vaultPath.replace(/[/\\][^/\\]*$/, "");
    const target = await syncApi.pickVaultFile("save", { defaultDir: dir });
    if (!target) return;
    const made = await syncApi.makeSeparateVault(target);
    offerOpenNewVault(made.path, COPY_READY_TITLE);
  } catch (err) {
    console.error("[sync] Make my own copy failed:", err);
    toast.error("Could not make your copy", errorText(err, "Try again."));
  }
}
