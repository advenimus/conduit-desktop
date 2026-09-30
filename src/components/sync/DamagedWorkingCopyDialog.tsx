import { AlertTriangleIcon } from "../../lib/icons";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";

interface DamagedWorkingCopyDialogProps {
  fileName: string;
  recoverable: boolean;
  busy: boolean;
  onRecover: () => void;
  onCancel: () => void;
}

/** VAULT_WORKING_COPY_DAMAGED: set the local copy aside and start again from the shared file. */
export default function DamagedWorkingCopyDialog({ fileName, recoverable, busy, onRecover, onCancel }: DamagedWorkingCopyDialogProps) {
  return (
    <SyncDialogFrame
      icon={AlertTriangleIcon}
      tone="danger"
      title="This computer's copy is damaged"
      onEscape={onCancel}
      footer={
        recoverable ? (
          <>
            <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
            <DialogButton variant="primary" onClick={onRecover} disabled={busy} autoFocus>
              {busy ? "Rebuilding..." : "Rebuild from shared file"}
            </DialogButton>
          </>
        ) : (
          <DialogButton variant="primary" onClick={onCancel} autoFocus>OK</DialogButton>
        )
      }
    >
      <p className="text-ink">Conduit keeps a working copy of '{fileName}' on this computer, and it can't be read.</p>
      {recoverable ? (
        <p>
          Conduit can set it aside and start again from the shared file. The damaged copy is kept, not deleted.
          Changes that had not synced yet stay in it.
        </p>
      ) : (
        <p>The shared file can't be read right now either. Try again when it is available.</p>
      )}
    </SyncDialogFrame>
  );
}
