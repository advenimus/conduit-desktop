import { useState } from "react";
import { RestoreIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { CandidatePreviewRow, RestoreResult, RollbackPreview } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { plural } from "./sync-copy";
import { offerOpenNewVault } from "./prompt-actions";

const MAX_LISTED = 8;

function Rows({ title, rows }: { title: string; rows: readonly CandidatePreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-ink mb-1">{title} ({rows.length})</p>
      <ul className="text-xs text-ink-muted list-disc pl-5 space-y-0.5">
        {rows.slice(0, MAX_LISTED).map((r) => <li key={rowKeyString(r.row)}>{r.title}</li>)}
        {rows.length > MAX_LISTED && <li>and {rows.length - MAX_LISTED} more</li>}
      </ul>
    </div>
  );
}

interface RestorePreviewDialogProps {
  preview: RollbackPreview;
  apply: (mode: "rollback" | "new-vault", targetPath: string | null) => Promise<RestoreResult>;
}

/** 5.10: roll the open vault back to a backup (after this preview), or restore it as a new vault. */
export default function RestorePreviewDialog({ preview, apply }: RestorePreviewDialogProps) {
  const [busy, setBusy] = useState(false);
  const close = () => useSyncStore.getState().closeView();
  const nothing = preview.deletions.length + preview.restorations.length + preview.replacements.length === 0;

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
  const rollBack = () => run(async () => {
    const res = await apply("rollback", null);
    close();
    toast.success(res.mode === "rollback" ? `Rolled back ${plural(res.applied, "change")}.` : "Vault restored.");
  }, "Could not roll back");
  const asNewVault = () => run(async () => {
    const target = await syncApi.pickVaultFile("save");
    if (!target) return;
    const res = await apply("new-vault", target);
    close();
    offerOpenNewVault(res.mode === "new-vault" ? res.path : target, "Backup restored as a new vault.");
  }, "Could not restore as a new vault");

  return (
    <SyncDialogFrame
      icon={RestoreIcon}
      title="Restore from backup"
      width="w-[540px]"
      onEscape={close}
      footer={
        <>
          <DialogButton onClick={close} disabled={busy}>Cancel</DialogButton>
          <DialogButton onClick={() => void asNewVault()} disabled={busy}>Restore as a new vault...</DialogButton>
          <DialogButton variant="primary" onClick={() => void rollBack()} disabled={busy || nothing}>Roll this vault back</DialogButton>
        </>
      }
    >
      <p>
        {nothing
          ? "This vault already matches the backup."
          : "Rolling back changes this vault on every device that syncs it. Replaced passwords stay in password history."}
      </p>
      <Rows title="Created since the backup (will be deleted)" rows={preview.deletions} />
      <Rows title="Deleted since the backup (will come back)" rows={preview.restorations} />
      {preview.replacements.length > 0 && (
        <p className="text-xs text-ink">{plural(preview.replacements.length, "newer value")} will be replaced with the backup's.</p>
      )}
      {preview.unreadableSecrets > 0 && (
        <p className="text-xs text-amber-400">{plural(preview.unreadableSecrets, "secret")} in the backup can't be read and stay as they are.</p>
      )}
    </SyncDialogFrame>
  );
}
