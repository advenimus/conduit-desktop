/**
 * Thin hooks the vault store calls around personal unlocks and restores, so the sync dialogs
 * (take-over, password changed elsewhere, restore preview) get their state.
 */

import { useSyncStore } from "./syncStore";
import { classifyUnlockError } from "./vault-unlock-errors";
import type { RestoreResult } from "../types/sync";

/** The vault-store fields these hooks write. */
interface UnlockFields {
  isLoading?: boolean;
  error?: string | null;
  lockedReason?: "open_elsewhere" | null;
}

type SetUnlockFields = (partial: UnlockFields) => void;

/** Structured errors go to the sync dialogs; plain ones to the dialog's error line. */
export function failUnlock(set: SetUnlockFields, err: unknown, fallback: string): void {
  const { payload, message } = classifyUnlockError(err, fallback);
  const sync = useSyncStore.getState();
  sync.setOpenWaiting(null);
  sync.setOpenError(payload);
  set({ isLoading: false, error: message });
}

export function unlockSucceeded(set: SetUnlockFields): void {
  const sync = useSyncStore.getState();
  sync.setOpenWaiting(null);
  sync.setOpenError(null);
  sync.setTakeoverMode(false);
  sync.setDisplaced(null);
  sync.setDisplacing(null);
  set({ lockedReason: null });
}

/**
 * An engine-managed vault answers a restore with a preview (spec 5.10). Opens the preview
 * dialog, which re-runs the restore as a rollback or a new vault. True when it did.
 */
export function showRestorePreview(
  result: RestoreResult | null | undefined,
  rerun: (mode: "rollback" | "new-vault", targetPath: string | null) => Promise<RestoreResult>,
): boolean {
  if (!result || result.mode !== "preview") return false;
  useSyncStore.getState().openView({ kind: "restore-preview", preview: result.preview, apply: rerun });
  return true;
}
