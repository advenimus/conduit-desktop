import { syncApi } from "../../lib/sync-api";
import { toast } from "../common/Toast";
import type { OpenErrorPayload, TakeoverHolder } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { Card } from "../ui";
import { deviceNameOr, holderActivity, holderBusyText, providerName } from "./sync-copy";

type OpenElsewhere = Extract<OpenErrorPayload, { code: "VAULT_OPEN_ELSEWHERE" }>;

interface TakeoverDialogProps {
  payload: OpenElsewhere;
  busy: boolean;
  onUseHere: () => void;
  onCancel: () => void;
}

function openPricing(): void {
  syncApi.openPricing().catch((err) => {
    console.error("[sync] Failed to open pricing:", err);
    toast.error("Could not open the pricing page");
  });
}

function HolderLine({ holder }: { holder: TakeoverHolder }) {
  const busy = holderBusyText(deviceNameOr(holder.deviceName), holder.busySessions, holder.busyJobs);
  return (
    <Card className="space-y-1">
      <p className="text-ink">This vault is open on {holderActivity(holder)}.</p>
      {busy && <p className="text-label text-ink-muted">{busy}</p>}
    </Card>
  );
}

/** 6.5: the vault is open on another device. [Use here instead] re-runs the unlock with takeover. */
export default function TakeoverDialog({ payload, busy, onUseHere, onCancel }: TakeoverDialogProps) {
  const first = payload.holders[0] ?? null;
  const freePlan = payload.limit === 1;
  return (
    <SyncDialogFrame
      icon="devices"
      tone="warn"
      title="Vault open on another device"
      onEscape={onCancel}
      footer={
        <>
          {freePlan && <DialogButton onClick={openPricing}>Upgrade to Pro</DialogButton>}
          <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={onUseHere} loading={busy} loadingLabel="Opening..." autoFocus>
            Use here instead
          </DialogButton>
        </>
      }
    >
      {payload.holders.length === 0 ? (
        <p>This vault is open on another device.</p>
      ) : (
        payload.holders.map((h) => <HolderLine key={h.deviceId} holder={h} />)
      )}
      {payload.locationDiffers && first && (
        <p>
          {deviceNameOr(first.deviceName)} has this vault open from {providerName(first.location)}. That may be a
          different copy than the one you are opening.
        </p>
      )}
      {freePlan && <p className="text-ink-muted">On the Free plan a vault can be open on one device at a time.</p>}
    </SyncDialogFrame>
  );
}
