import { useEffect, useState } from "react";
import { syncApi } from "../../lib/sync-api";
import { errorText } from "../../lib/errorText";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { SessionConflictEvent } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { DEFAULT_DEVICE_CAP, deviceNameOr, holderActivity } from "./sync-copy";

const TICK_MS = 1000;

function secondsLeft(answerByMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((answerByMs - nowMs) / TICK_MS));
}

/** 6.8 reachable again: another device also holds the vault. No answer: this device soft-locks. */
export default function SessionConflictDialog({ event }: { event: SessionConflictEvent }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const left = secondsLeft(event.answerByMs, now);
  const first = event.holders[0] ?? null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (left === 0) useSyncStore.getState().setSessionConflict(null);
  }, [left]);

  const answer = async (choice: "use-here" | "lock-here") => {
    setBusy(true);
    try {
      if (choice === "use-here") await syncApi.sessionTakeover();
      else await syncApi.sessionLockHere();
      useSyncStore.getState().setSessionConflict(null);
    } catch (err) {
      toast.error("Could not answer", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const deviceCap = event.cause === "device_cap";
  return (
    <SyncDialogFrame
      icon="devices"
      tone="warn"
      title={deviceCap ? "Too many devices" : `Also open on ${deviceNameOr(first?.deviceName)}`}
      footer={
        <>
          <DialogButton onClick={() => void answer("lock-here")} disabled={busy}>Lock here</DialogButton>
          <DialogButton variant="primary" onClick={() => void answer("use-here")} disabled={busy} autoFocus>
            Use here instead
          </DialogButton>
        </>
      }
    >
      {deviceCap ? (
        <>
          <p className="text-ink">You're using Conduit on {event.deviceCap ?? DEFAULT_DEVICE_CAP} devices. Close one to use it here.</p>
          <p>Using it here locks your vaults on {deviceNameOr(first?.deviceName)}.</p>
        </>
      ) : (
        <p className="text-ink">
          This vault is also open on {first ? holderActivity(first) : "another device"}.
        </p>
      )}
      <p>Your changes are saved on this device. If you don't answer, the vault locks here in {left} seconds.</p>
    </SyncDialogFrame>
  );
}
