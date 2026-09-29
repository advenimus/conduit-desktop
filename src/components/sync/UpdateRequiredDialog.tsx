import { useState } from "react";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { updateConduit } from "./plan-actions";

/** S9: the server's minimum version is above this app's. */
export default function UpdateRequiredDialog({ minVersion, onCancel }: { minVersion: string; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    try {
      await updateConduit();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SyncDialogFrame
      icon="download"
      tone="warn"
      title="Update required"
      onEscape={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={() => void update()} loading={busy} loadingLabel="Checking..." autoFocus>
            Update Conduit
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">This version of Conduit can't open your vaults anymore. Update to version {minVersion} or later.</p>
    </SyncDialogFrame>
  );
}
