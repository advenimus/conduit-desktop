import { useState } from "react";
import { syncApi, errorText } from "../../lib/sync-api";
import { toast } from "../common/Toast";
import type { WaitingDevice, WaitingForDriveState } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { Spinner } from "../ui";
import { deviceNameOr, formatAgo } from "./sync-copy";

function deviceLabel(d: WaitingDevice | undefined): string {
  return deviceNameOr(d?.deviceName);
}

/** "Getting the latest version from MacBook (saved 2 minutes ago)..." */
export function waitingText(w: WaitingForDriveState, nowMs: number = Date.now()): string {
  const first = w.devices[0];
  const name = deviceLabel(first);
  if (w.purpose === "first-genesis") return `Waiting for the synced vault from ${name}...`;
  const saved = first?.savedAtMs ? ` (saved ${formatAgo(first.savedAtMs, nowMs)})` : "";
  return `Getting the latest version from ${name}${saved}...`;
}

async function run(action: () => Promise<void>, failTitle: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    toast.error(failTitle, errorText(err, "Try again."));
  }
}

interface WaitActionsProps {
  waiting: WaitingForDriveState;
  duringUnlock: boolean;
}

/** [Open now] / [Continue anyway] and [Stop waiting for X] (only while the vault is open). */
export function WaitActions({ waiting, duringUnlock }: WaitActionsProps) {
  const [busy, setBusy] = useState(false);
  const openLabel = waiting.purpose === "first-genesis" ? "Continue anyway" : "Open now";
  const openNow = async () => {
    setBusy(true);
    await run(() => syncApi.sessionOpenNow(), "Could not continue");
    setBusy(false);
  };
  const stopFor = (d: WaitingDevice) => run(() => syncApi.sessionStopWaiting(d.deviceId), "Could not stop waiting");
  return (
    <>
      {waiting.stopOffered && !duringUnlock &&
        waiting.devices.map((d) => (
          <DialogButton key={d.deviceId} onClick={() => void stopFor(d)}>
            Stop waiting for {deviceLabel(d)}
          </DialogButton>
        ))}
      <DialogButton variant="primary" onClick={() => void openNow()} disabled={busy}>
        {openLabel}
      </DialogButton>
    </>
  );
}

/** Blocking stale-file wait (6.11, Free) or the first-open wait inside an unlock (4.4 G1). */
export default function WaitingForDriveDialog({ waiting, duringUnlock }: WaitActionsProps) {
  return (
    <SyncDialogFrame
      icon="cloudDownload"
      title="Getting the latest changes"
      footer={<WaitActions waiting={waiting} duringUnlock={duringUnlock} />}
    >
      <div className="flex items-center gap-2 text-ink">
        <Spinner className="shrink-0 text-link" />
        <span>{waitingText(waiting)}</span>
      </div>
      <p>Conduit continues on its own when the file arrives. Opening now is safe: changes merge when they arrive.</p>
    </SyncDialogFrame>
  );
}
