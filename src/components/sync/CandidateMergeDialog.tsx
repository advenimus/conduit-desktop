import { useEffect, useState } from "react";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { CandidatePreview, CandidatePreviewRow, SyncRowKey } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { Checkbox, Spinner } from "../ui";
import { formatValue, MASKED_VALUE } from "./conflict-logic";
import { plural } from "./sync-copy";
import { confirmSideFilesAfterReview } from "./side-files-actions";

const MAX_LISTED = 8;

function RowList({ title, rows }: { title: string; rows: readonly CandidatePreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-label font-semibold text-ink">{title} ({rows.length})</p>
      <ul className="text-label text-ink-muted list-disc pl-5 space-y-0.5">
        {rows.slice(0, MAX_LISTED).map((r) => <li key={rowKeyString(r.row)}>{r.title}</li>)}
        {rows.length > MAX_LISTED && <li>and {rows.length - MAX_LISTED} more</li>}
      </ul>
    </div>
  );
}

function ChangedFields({ preview }: { preview: CandidatePreview }) {
  if (preview.changedFields.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-label font-semibold text-ink">Different values ({preview.changedFields.length})</p>
      <div className="max-h-40 overflow-y-auto rounded border border-stroke divide-y divide-stroke-dim">
        {preview.changedFields.slice(0, 50).map((f) => (
          <div key={`${rowKeyString(f.key)}:${f.key.reg}`} className="px-2 py-1.5 text-label">
            <span className="text-ink">{f.rowTitle}</span> <span className="text-ink-muted">{f.label}:</span>{" "}
            <span className="font-mono">{f.masked ? MASKED_VALUE : formatValue(f.current)}</span>
            <span className="text-ink-muted"> in the vault, </span>
            <span className="font-mono">{f.masked ? MASKED_VALUE : formatValue(f.incoming)}</span>
            <span className="text-ink-muted"> in the copy</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A replica copy's own edits and deletes apply on [Merge] like the shared file's (4.3); only a
 * change your vault also made becomes a review item. A synthetic copy's differences all do.
 */
function introText(kind: CandidatePreview["kind"]): string {
  return kind === "replica"
    ? "Merging applies the changes in this copy. Where your vault changed the same item since, you review both versions."
    : "Merging keeps both sides. Values that differ become changes you review, so nothing is lost.";
}

interface CandidateMergeDialogProps {
  candidateId: string;
  confirmSideFilesAfter: boolean;
}

/** 4.9 candidate preview: merge a copy's changes into the vault; differences become conflicts to review. */
export default function CandidateMergeDialog({ candidateId, confirmSideFilesAfter }: CandidateMergeDialogProps) {
  const [preview, setPreview] = useState<CandidatePreview | null>(null);
  const [deleteMissing, setDeleteMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => useSyncStore.getState().closeView();

  useEffect(() => {
    syncApi.candidatePreview(candidateId).then(setPreview).catch((err) => {
      toast.error("Could not open the copy", errorText(err, "Try again."));
      close();
    });
  }, [candidateId]);

  const finish = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      const message = await action();
      close();
      if (confirmSideFilesAfter) await confirmSideFilesAfterReview();
      toast.success(message);
    } catch (err) {
      toast.error("Could not finish", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const merge = () =>
    finish(async () => {
      const rows: SyncRowKey[] = deleteMissing && preview ? preview.missingFromCopy.map((r) => r.row) : [];
      const res = await syncApi.candidateApply(candidateId, rows);
      await useSyncStore.getState().refresh();
      return res.conflictCount > 0 ? `Merged. ${plural(res.conflictCount, "change")} to review.` : "Merged.";
    });
  const discard = () => finish(async () => {
    await syncApi.candidateDiscard(candidateId);
    return "Copy set aside. Nothing was merged.";
  });

  return (
    <SyncDialogFrame
      icon="fileImport"
      title={preview ? `Merge '${preview.label}'?` : "Merge a copy"}
      width={560}
      onEscape={close}
      footer={
        <>
          <DialogButton onClick={close} disabled={busy}>Later</DialogButton>
          <DialogButton onClick={() => void discard()} disabled={busy || !preview}>Don't merge</DialogButton>
          <DialogButton variant="primary" onClick={() => void merge()} disabled={busy || !preview}>Merge</DialogButton>
        </>
      }
    >
      {!preview ? (
        <Spinner text="Comparing..." />
      ) : (
        <>
          <p>{introText(preview.kind)}</p>
          <ChangedFields preview={preview} />
          <RowList title="Only in this copy (they will be added)" rows={preview.onlyInCopy} />
          <RowList title="Deleted in this copy (merging deletes them unless your vault changed them since)" rows={preview.deletions} />
          <RowList title="Missing from this copy" rows={preview.missingFromCopy} />
          {preview.missingFromCopy.length > 0 && (
            <Checkbox checked={deleteMissing} onChange={setDeleteMissing}>
              Delete the missing items from the vault too
            </Checkbox>
          )}
        </>
      )}
    </SyncDialogFrame>
  );
}
