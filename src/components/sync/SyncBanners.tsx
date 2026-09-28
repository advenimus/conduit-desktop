import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { useVaultStore } from "../../stores/vaultStore";
import { activeStatus, currentWaiting, visiblePrompts } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { SyncPrompt, WaitingForDriveState } from "../../types/sync";
import SyncBanner from "./SyncBanner";
import PromptBanner, { MODAL_PROMPT_KINDS } from "./PromptBanner";
import { waitingText } from "./WaitingForDriveDialog";
import { deviceNameOr, plural } from "./sync-copy";

const EPOCH_PROMPT_KINDS: ReadonlySet<SyncPrompt["kind"]> = new Set(["epoch-newer", "epoch-legacy", "epoch-concurrent"]);

function useHere(): void {
  useSyncStore.getState().setTakeoverMode(true);
  document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
}

function SoftLockBanner() {
  return (
    <SyncBanner
      tone="lock"
      text="This vault is open on another device. Your open connections keep running."
      actions={[
        { label: "Use here instead", primary: true, onClick: useHere },
        { label: "Close vault", onClick: () => document.dispatchEvent(new CustomEvent("conduit:lock-vault")) },
      ]}
    />
  );
}

async function waitAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    toast.error("Could not update the wait", errorText(err, "Try again."));
  }
}

function WaitingBanner({ waiting }: { waiting: WaitingForDriveState }) {
  const stops = waiting.stopOffered
    ? waiting.devices.map((d) => ({
        label: `Stop waiting for ${deviceNameOr(d.deviceName)}`,
        onClick: () => void waitAction(() => syncApi.sessionStopWaiting(d.deviceId)),
      }))
    : [];
  return (
    <SyncBanner
      tone="info"
      text={waitingText(waiting)}
      actions={[...stops, { label: "Open now", primary: true, onClick: () => void waitAction(() => syncApi.sessionOpenNow()) }]}
    />
  );
}

/** A password prompt put off with [Later]: syncing stays paused, so it stays one click away. */
function DeferredPasswordBanner({ promptId }: { promptId: string }) {
  return (
    <SyncBanner
      tone="warn"
      text="Syncing is paused until you enter the master password set on another device."
      actions={[{ label: "Enter password", primary: true, onClick: () => useSyncStore.getState().undeferPrompt(promptId) }]}
    />
  );
}

function ReviewBanner({ count }: { count: number }) {
  const text = count === 1 ? "1 change from your other devices needs review." : `${plural(count, "change")} from your other devices need review.`;
  return (
    <SyncBanner
      tone="warn"
      text={text}
      actions={[
        { label: "Review", primary: true, onClick: () => useSyncStore.getState().openView({ kind: "review", row: null }) },
        { label: "Later", onClick: () => useSyncStore.getState().closeReviewBanner() },
      ]}
    />
  );
}

/** Status strips above the main area: soft lock, stale-file wait, prompts, "N to review". */
export default function SyncBanners() {
  const lockedReason = useVaultStore((s) => s.lockedReason);
  const state = useSyncStore((s) => s.state);
  const openWaiting = useSyncStore((s) => s.openWaiting);
  const deferred = useSyncStore((s) => s.deferredPrompts);
  const closedFor = useSyncStore((s) => s.reviewBannerClosedFor);

  if (lockedReason === "open_elsewhere") return <SoftLockBanner />;
  const status = activeStatus(state);
  if (status === null) return null;
  const waiting = currentWaiting(openWaiting, state);
  const prompts = visiblePrompts(state, deferred).filter((p) => !MODAL_PROMPT_KINDS.has(p.kind));
  const deferredPassword = (status.prompts ?? []).find((p) => EPOCH_PROMPT_KINDS.has(p.kind) && deferred.has(p.id)) ?? null;
  const showReview = status.conflictCount > 0 && closedFor !== status.lineageId;
  const fileName = state?.vault?.fileName ?? status.fileName ?? "this vault";
  return (
    <>
      {waiting && !waiting.blocking && <WaitingBanner waiting={waiting} />}
      {deferredPassword && <DeferredPasswordBanner promptId={deferredPassword.id} />}
      {prompts.map((p) => <PromptBanner key={p.id} prompt={p} fileName={fileName} />)}
      {showReview && <ReviewBanner count={status.conflictCount} />}
    </>
  );
}
