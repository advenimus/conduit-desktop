import { useState } from "react";
import type { SyncPrompt } from "../../types/sync";
import SyncBanner from "./SyncBanner";
import { confirmSideFiles, reviewSideFileWal } from "./side-files-actions";

type SideFilesPrompt = Extract<SyncPrompt, { kind: "side-files" }>;

/** Spec 5.5 texts: an older desktop may have the vault open in place. */
export function sideFilesText(prompt: SideFilesPrompt): string {
  if (prompt.upgradeWording) {
    return "Conduit found files left by the previous version on this computer. If Conduit isn't open on another computer, choose Continue.";
  }
  return "An older version of Conduit may have this vault open on another computer. Update or close it there to sync safely. Your changes are saved on this device.";
}

/** Publishing is paused while legacy -wal/-shm files sit next to the shared file. */
export default function SideFilesPausedBanner({ prompt }: { prompt: SideFilesPrompt }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const label = prompt.walNonEmpty
    ? "Review unsaved changes first"
    : prompt.upgradeWording
      ? "Continue"
      : "Conduit is closed on my other computers";
  const action = prompt.walNonEmpty ? reviewSideFileWal : confirmSideFiles;
  return (
    <SyncBanner
      tone="warn"
      text={sideFilesText(prompt)}
      actions={[{ label, primary: true, disabled: busy, onClick: () => void run(action) }]}
    />
  );
}
