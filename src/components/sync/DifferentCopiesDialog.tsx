import { useState } from "react";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { SyncPrompt } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { deviceNameOr, providerPlace } from "./sync-copy";
import { dismissPrompt, offerOpenNewVault } from "./prompt-actions";

type DifferentCopies = Extract<SyncPrompt, { kind: "different-copies" }>;

/** "MacBook syncs 'Vault.conduit' in iCloud Drive. This computer syncs 'Vault.conduit' in OneDrive." */
export function differentCopiesText(prompt: DifferentCopies): string {
  const other = deviceNameOr(prompt.deviceName);
  return (
    `${other} syncs '${prompt.theirs.file_name}' ${providerPlace(prompt.theirs.location)}. ` +
    `This computer syncs '${prompt.ours.file_name}' ${providerPlace(prompt.ours.location)}. ` +
    "These are separate copies and they aren't syncing with each other."
  );
}

/** Spec 5.8: two devices sync different copies of the same vault. */
export default function DifferentCopiesDialog({ prompt }: { prompt: DifferentCopies }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(failTitle, errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };
  const merge = () =>
    run(async () => {
      const path = await syncApi.pickVaultFile("open");
      if (!path) return;
      const { candidateId } = await syncApi.candidateAddFile(path);
      useSyncStore.getState().deferPrompt(prompt.id);
      useSyncStore.getState().openView({ kind: "candidate", candidateId, confirmSideFilesAfter: false });
    }, "Could not open that copy");
  const keepSeparate = () =>
    run(async () => {
      const target = await syncApi.pickVaultFile("save");
      if (!target) return;
      const fork = await syncApi.makeSeparateVault(target, prompt.id);
      await useSyncStore.getState().refresh();
      offerOpenNewVault(fork.path, "Saved as a separate vault.");
    }, "Could not make a separate vault");
  const later = () => run(() => dismissPrompt(prompt.id), "Could not dismiss");

  return (
    <SyncDialogFrame
      icon="devices"
      tone="warn"
      title="Two copies of this vault"
      width={500}
      onEscape={() => void later()}
      footer={
        <>
          <DialogButton onClick={() => void later()} disabled={busy}>Remind me later</DialogButton>
          <DialogButton onClick={() => void keepSeparate()} disabled={busy}>Keep separate</DialogButton>
          <DialogButton variant="primary" onClick={() => void merge()} disabled={busy}>Merge them...</DialogButton>
        </>
      }
    >
      <p className="text-ink">{differentCopiesText(prompt)}</p>
      <p>Merge them to keep one vault, or keep them as two separate vaults.</p>
    </SyncDialogFrame>
  );
}
