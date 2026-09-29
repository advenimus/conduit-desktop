import { syncApi } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { DisplacedEvent, DisplacingEvent } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { DEFAULT_DEVICE_CAP, deviceNameOr, stillRunningText } from "./sync-copy";
import { updateConduit } from "./plan-actions";

interface DisplacedCopy {
  readonly title: string;
  readonly body: string;
  readonly upgrade: boolean;
  /** [Use here instead]: false when using it here cannot work (not owner, update required). */
  readonly useHere: boolean;
  /** [Update Conduit] (S10). */
  readonly update?: boolean;
}

/** Spec 6.6 texts per displacement reason; plan enforcement S2, S8, S8b, S10. */
export function displacedCopy(ev: DisplacedEvent): DisplacedCopy {
  const by = deviceNameOr(ev.byDeviceName);
  switch (ev.reason) {
    case "device_cap":
      return {
        title: "Vault locked",
        body: `You opened Conduit on ${by}. Your plan allows ${ev.deviceCap ?? DEFAULT_DEVICE_CAP} devices at once, so your vaults locked here.`,
        upgrade: false,
        useHere: true,
      };
    case "not_owner":
      return {
        title: "Vault locked",
        body: ev.released
          ? "You released this vault and another account now owns it. Unlock it again to make your own copy."
          : "This vault belongs to another Conduit account, and your 14 days of access ended. Unlock it again to make your own copy.",
        upgrade: false,
        useHere: false,
      };
    case "update_required":
      return { title: "Vault locked", body: "Update Conduit to keep using this vault.", upgrade: false, useHere: false, update: true };
    case "plan_limit":
      return { title: "Vault locked", body: `Your plan now allows this vault on one device at a time. It stays open on ${by}.`, upgrade: true, useHere: true };
    case "owner_claim":
      return { title: "Vault locked", body: `This vault was opened on ${by}. On the Free plan a vault can be open on one device at a time.`, upgrade: false, useHere: true };
    case "superseded":
      return { title: "Vault locked", body: "Conduit was opened with this computer's identity somewhere else.", upgrade: false, useHere: true };
    case "reconnect_unanswered":
      return { title: "Vault locked", body: `This vault is also open on ${by}, so it locked here.`, upgrade: false, useHere: true };
    case "yielded":
      return { title: "Vault locked", body: `The vault stays open on ${by}.`, upgrade: false, useHere: true };
    case "takeover":
      return { title: `Opened on ${by}`, body: `This vault is now open on ${by}.`, upgrade: false, useHere: true };
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
          <DialogButton onClick={close} autoFocus={!copy.useHere && !copy.update}>OK</DialogButton>
          {copy.update && (
            <DialogButton variant="primary" onClick={() => void updateConduit()} autoFocus>
              Update Conduit
            </DialogButton>
          )}
          {copy.useHere && (
            <DialogButton variant="primary" onClick={useHere} autoFocus>
              Use here instead
            </DialogButton>
          )}
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
