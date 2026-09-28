import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { ConfirmSideFilesResult } from "../../types/sync";

async function confirm(walReviewed: boolean): Promise<ConfirmSideFilesResult> {
  const tuples = useSyncStore.getState().state?.sideFiles ?? [];
  return syncApi.confirmSideFiles(tuples, walReviewed);
}

/** Opens the WAL review ([Review unsaved changes first]); confirming follows the candidate dialog. */
export async function reviewSideFileWal(): Promise<void> {
  try {
    const { candidateId } = await syncApi.reviewSideFileWal();
    useSyncStore.getState().openView({ kind: "candidate", candidateId, confirmSideFilesAfter: true });
  } catch (err) {
    toast.error("Could not open the unsaved changes", errorText(err, "Try again."));
  }
}

async function handleResult(result: ConfirmSideFilesResult): Promise<void> {
  switch (result.kind) {
    case "confirmed":
      toast.success("Syncing resumed.");
      break;
    case "held-open":
      toast.info("Syncing resumed. Review the changes the older Conduit made.");
      break;
    case "review-first":
      await reviewSideFileWal();
      break;
    case "changed":
      toast.warning("The older Conduit's files changed. Check that it is closed, then try again.");
      break;
  }
  await useSyncStore.getState().refresh();
}

/** [Conduit is closed on my other computers] / [Continue]. */
export async function confirmSideFiles(): Promise<void> {
  try {
    await handleResult(await confirm(false));
  } catch (err) {
    toast.error("Could not resume syncing", errorText(err, "Try again."));
  }
}

/** After the WAL copy was reviewed (merged or not), confirm with walReviewed. */
export async function confirmSideFilesAfterReview(): Promise<void> {
  try {
    await handleResult(await confirm(true));
  } catch (err) {
    toast.error("Could not resume syncing", errorText(err, "Try again."));
  }
}
