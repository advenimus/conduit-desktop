import { syncApi } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { DisplacedEvent, DisplacingEvent } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { deviceNameOr, stillRunningText } from "./sync-copy";

interface DisplacedCopy {
  readonly title: string;
  readonly body: string;
  readonly upgrade: boolean;
}

/** Spec 6.6 texts per displacement reason. */
export function displacedCopy(ev: DisplacedEvent): DisplacedCopy {
  const by = deviceNameOr(ev.byDeviceName);
  switch (ev.reason) {
    case "plan_limit":
      return { title: "Vault locked", body: `Your plan now allows this vault on one device at a time. It stays open on ${by}.`, upgrade: true };
    case "owner_claim":
      return { title: "Vault locked", body: `This vault was opened on ${by}. On the Free plan a vault can be open on one device at a time.`, upgrade: false };
    case "superseded":
      return { title: "Vault locked", body: "Conduit was opened with this computer's identity somewhere else.", upgrade: false };
    case "reconnect_unanswered":
      return { title: "Vault locked", body: `This vault is also open on ${by}, so it locked here.`, upgrade: false };
    case "yielded":
      return { title: "Vault locked", body: `The vault stays open on ${by}.`, upgrade: false };
    case "takeover":
      return { title: `Opened on ${by}`, body: `This vault is now open on ${by}.`, upgrade: false };
  }
}

/** "Your changes from this device were saved." plus what is still running. */
export function displacedDetails(ev: DisplacedEvent): string[] {
  const saved = ev.changesSaved
    ? "Your changes from this device were saved."
    : "Your last changes stay on this device. They sync the next time you unlock here.";
  const running = stillRunningText(ev.openConnections, ev.runningJobs);
  return running === null ? [saved] : [saved, running];
}

function openPricing(): void {
  syncApi.openPricing().catch((err) => {
    console.error("[sync] Failed to open pricing:", err);
    toast.error("Could not open the pricing page");
  });
}

/** 6.6 step 1: "Opened on iPhone. Saving your last changes..." while access is already blocked. */
export function displacingTitle(ev: DisplacingEvent): string {
  return ev.reason === "yielded" ? "Locking this vault here" : `Opened on ${deviceNameOr(ev.byDeviceName)}`;
}

/** Shown from the moment vault access is blocked until the soft-lock notice replaces it. */
export function DisplacingOverlay({ event }: { event: DisplacingEvent }) {
  return (
    <SyncDialogFrame icon="lock" tone="warn" title={displacingTitle(event)} footer={null}>
      <p className="text-ink">Saving your last changes...</p>
      <p>Your open connections keep running.</p>
    </SyncDialogFrame>
  );
}

/** Soft lock notice (6.6). The vault is locked; connections keep running. */
export default function DisplacedDialog({ event }: { event: DisplacedEvent }) {
  const copy = displacedCopy(event);
  const close = () => useSyncStore.getState().setDisplaced(null);
  const useHere = () => {
    const store = useSyncStore.getState();
    store.setDisplaced(null);
    store.setTakeoverMode(true);
    document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
  };
  return (
    <SyncDialogFrame
      icon="lock"
      tone="warn"
      title={copy.title}
      onEscape={close}
      footer={
        <>
          {copy.upgrade && <DialogButton onClick={openPricing}>Upgrade</DialogButton>}
          <DialogButton onClick={close}>OK</DialogButton>
          <DialogButton variant="primary" onClick={useHere} autoFocus>
            Use here instead
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">{copy.body}</p>
      {displacedDetails(event).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </SyncDialogFrame>
  );
}
