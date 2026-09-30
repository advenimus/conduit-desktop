import { syncApi } from "../../lib/sync-api";
import { toast } from "../common/Toast";
import type { OpenErrorPayload, TakeoverHolder } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { Card } from "../ui";
import { DEFAULT_DEVICE_CAP, deviceHolderLine, deviceNameOr, holderActivity, holderBusyText, providerName } from "./sync-copy";

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

/** S1b: a Free take-over that also locks another device for the account's device cap. */
export function alsoLocksText(payload: OpenElsewhere): string | null {
  if (payload.alsoLockDeviceName == null) return null;
  const n = payload.deviceCap ?? DEFAULT_DEVICE_CAP;
  return `Conduit will also lock your vaults on ${deviceNameOr(payload.alsoLockDeviceName)}, because you're using Conduit on ${n} devices.`;
}

/** S1: too many devices. [Use here instead] locks the least recently used one. */
function DeviceCapDialog({ payload, busy, onUseHere, onCancel }: TakeoverDialogProps) {
  const n = payload.deviceCap ?? payload.holders.length;
  const victim = deviceNameOr(payload.displaceDeviceName ?? payload.holders[0]?.deviceName);
  return (
    <SyncDialogFrame
      icon="devices"
      tone="warn"
      title="Too many devices"
      onEscape={onCancel}
      footer={
        <>
          <DialogButton onClick={onCancel} disabled={busy}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={onUseHere} loading={busy} loadingLabel="Opening..." autoFocus>
            Use here instead
          </DialogButton>
        </>
      }
    >
      <p className="text-ink">You're using Conduit on {n} devices. Close one to use it here.</p>
      {payload.holders.map((h) => (
        <Card key={h.deviceId}>
          <p className="text-ink">{deviceHolderLine(h)}</p>
        </Card>
      ))}
      <p>Conduit will lock your vaults on {victim}, the one you used least recently.</p>
    </SyncDialogFrame>
  );
}

/** 6.5: the vault is open on another device. [Use here instead] re-runs the unlock with takeover. */
export default function TakeoverDialog(props: TakeoverDialogProps) {
  const { payload, busy, onUseHere, onCancel } = props;
  if (payload.cause === "device_cap") return <DeviceCapDialog {...props} />;
  const first = payload.holders[0] ?? null;
  const alsoLocks = alsoLocksText(payload);
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
      {alsoLocks && <p>{alsoLocks}</p>}
    </SyncDialogFrame>
  );
}
