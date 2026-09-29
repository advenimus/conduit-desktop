import { syncApi } from "../../lib/sync-api";
import { errorText } from "../../lib/errorText";
import { useSyncStore } from "../../stores/syncStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import type { CopyAction, CopyInfo } from "../../types/sync";

async function guarded(failTitle: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`[sync] ${failTitle}:`, err);
    toast.error(failTitle, errorText(err, "Try again."));
  }
}

/** Locks the open vault and opens another file, then asks for its password. */
export async function openOtherVault(path: string): Promise<void> {
  await guarded("Could not open the vault", async () => {
    await useVaultStore.getState().lockVault();
    useEntryStore.setState({ entries: [], folders: [] });
    await useVaultStore.getState().openVault(path);
    useVaultStore.getState().setShowVaultHub(false);
    document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
  });
}

/** Offers to open a vault written by "separate vault" or "restore as new vault". */
export function offerOpenNewVault(path: string, title: string): void {
  toast.success(title, {
    message: "It opens with the same master password.",
    actions: [{ label: "Open it", variant: "primary", onClick: () => void openOtherVault(path) }],
  });
}

export function locateVaultFile(): Promise<void> {
  return guarded("Could not use that file", async () => {
    const path = await syncApi.pickVaultFile("open");
    if (!path) return;
    const ok = await syncApi.locateFile(path);
    if (ok) toast.success("Found the vault file. Syncing again.");
    else toast.warning("That file is not this vault.", "Pick the file that holds this vault.");
    await useSyncStore.getState().refresh();
  });
}

export function saveNewCopyHere(): Promise<void> {
  return guarded("Could not save a new copy", async () => {
    const path = await syncApi.pickVaultFile("save");
    if (!path) return;
    const ok = await syncApi.saveNewCopy(path);
    if (ok) toast.success("Saved a new copy. Syncing to it now.");
    await useSyncStore.getState().refresh();
  });
}

export function dismissPrompt(promptId: string): Promise<void> {
  return guarded("Could not dismiss", () => useSyncStore.getState().dismissPrompt(promptId));
}

export function applyHeld(choice: "apply" | "keep-mine"): Promise<void> {
  return guarded("Could not apply the choice", async () => {
    await syncApi.heldApply(choice);
    toast.success(choice === "apply" ? "Applied the older app's changes." : "Kept your versions.");
    await useSyncStore.getState().refresh();
  });
}

/** Runs a copy action; 'review' and 'merge' open the candidate preview, 'separate' asks where to save. */
export function copyAction(copy: CopyInfo, action: CopyAction): Promise<void> {
  return guarded("Could not update the copy", async () => {
    let target: string | undefined;
    if (action === "separate") {
      target = (await syncApi.pickVaultFile("save")) ?? undefined;
      if (!target) return;
    }
    const res = await syncApi.copyAction(copy.path, action, target);
    if (res.candidateId) {
      useSyncStore.getState().openView({ kind: "candidate", candidateId: res.candidateId, confirmSideFilesAfter: false });
    } else if (action === "trash") {
      toast.success(`Moved '${copy.name}' to the Trash.`);
    } else if (action === "separate" && target) {
      offerOpenNewVault(target, "Saved as a separate vault.");
    }
    await useSyncStore.getState().refresh();
  });
}

export function reviewCandidate(candidateId: string): void {
  useSyncStore.getState().openView({ kind: "candidate", candidateId, confirmSideFilesAfter: false });
}
