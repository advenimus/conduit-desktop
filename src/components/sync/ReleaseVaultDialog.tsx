import { useState } from "react";
import { useSyncStore } from "../../stores/syncStore";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { releaseVault } from "./plan-actions";

/** S12: [Release] runs vault_owner_release; the result is a toast (S13, S14, S23). */
export default function ReleaseVaultDialog() {
  const [busy, setBusy] = useState(false);
  const close = () => useSyncStore.getState().setReleaseDialogOpen(false);
  const release = async () => {
    setBusy(true);
    try {
      await releaseVault();
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <SyncDialogFrame
      icon="key"
      tone="warn"
      title="Release this vault?"
      onEscape={busy ? undefined : close}
      footer={
        <>
          <DialogButton onClick={close} disabled={busy}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={() => void release()} loading={busy} loadingLabel="Releasing..." autoFocus>
            Release
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">The next Conduit account that opens it becomes its owner. If you open it again first, it stays yours.</p>
    </SyncDialogFrame>
  );
}
