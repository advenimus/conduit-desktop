import { toast, type ToastAction } from "../common/Toast";
import { syncApi } from "../../lib/sync-api";
import { errorText } from "../../lib/errorText";
import { useSyncStore } from "../../stores/syncStore";
import type { LocalNotice, SyncNoticeEvent, TransientNotice } from "../../types/sync";
import { baseName, noticeText, plural, providerName } from "./sync-copy";

export interface NoticeToast {
  readonly type: "info" | "warning" | "success";
  readonly title: string;
  readonly message?: string;
  readonly action?: "undo-rebind" | "other-copies" | "mass-change";
}

function param(notice: TransientNotice, name: string): string | null {
  const v = notice.params[name];
  return v === null || v === undefined ? null : String(v);
}

function countParam(notice: TransientNotice): number {
  const v = notice.params.count ?? notice.params.n;
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** Plain copy for a one-shot notice. */
export function transientToast(notice: TransientNotice): NoticeToast {
  switch (notice.kind) {
    case "copy-merged": {
      const provider = param(notice, "provider");
      const name = param(notice, "name");
      const who = provider ? `${providerName(provider)} made` : "your cloud drive made";
      return { type: "info", title: `Merged changes from a copy ${who}.`, message: name ? `'${baseName(name)}'` : undefined, action: "other-copies" };
    }
    case "rebound":
      return { type: "info", title: "Found the vault file under its new name.", message: param(notice, "to") ?? undefined, action: "undo-rebind" };
    case "side-files-reminder":
      return { type: "warning", title: "Syncing is paused until the older Conduit is closed." };
    case "regression-backoff":
      return { type: "warning", title: "Your cloud drive keeps restoring an older copy.", message: "Your changes are safe on this device." };
    case "network-root":
      return { type: "info", title: "Sync data is on a network drive, so Conduit uses a slower safe mode." };
    case "dev-collision":
      return { type: "info", title: "Conduit fixed a copied device identity." };
    case "publish-failed":
      return { type: "warning", title: "Could not save to the shared file. Will retry." };
    case "content-repaired":
      return { type: "info", title: "Updated the shared file for older Conduit apps." };
    case "pending-at-start":
      return { type: "info", title: `${plural(Math.max(1, countParam(notice)), "change")} exist only on this device.` };
  }
}

/** Toast for a persisted notice as it arrives; null when the notice only shows in the review panel. */
export function persistedToast(notice: LocalNotice): NoticeToast | null {
  if (notice.kind === "mass-change") return { type: "warning", title: noticeText(notice), action: "mass-change" };
  if (notice.kind === "undecryptable-secrets" || notice.kind === "candidate-dropped") return { type: "warning", title: noticeText(notice) };
  return null;
}

async function undoRebind(): Promise<void> {
  try {
    const ok = await syncApi.undoRebind();
    if (!ok) toast.info("Nothing to undo.");
  } catch (err) {
    toast.error("Could not undo", errorText(err, "Try again."));
  }
}

function actionsFor(t: NoticeToast, notice: LocalNotice | TransientNotice): ToastAction[] | undefined {
  const store = useSyncStore.getState();
  switch (t.action) {
    case "undo-rebind":
      return [{ label: "Undo", variant: "primary", onClick: () => void undoRebind() }];
    case "other-copies":
      return [{ label: "Show copies", onClick: () => store.openView({ kind: "other-copies" }) }];
    case "mass-change":
      return [{ label: "Review", variant: "primary", onClick: () => store.openView({ kind: "mass-change", noticeId: notice.id }) }];
    default:
      return undefined;
  }
}

function show(t: NoticeToast, notice: LocalNotice | TransientNotice): void {
  const actions = actionsFor(t, notice);
  const options = { message: t.message, actions, persistent: t.action === "mass-change" };
  if (t.type === "warning") toast.warning(t.title, options);
  else if (t.type === "success") toast.success(t.title, options);
  else toast.info(t.title, options);
}

/** Handles `sync:notice`: toasts, and persisted notices into the store. */
export function handleSyncNotice(ev: SyncNoticeEvent): void {
  if (ev.persisted) {
    useSyncStore.getState().applyPersistedNotice(ev);
    const t = persistedToast(ev.notice);
    if (t) show(t, ev.notice);
    return;
  }
  show(transientToast(ev.notice), ev.notice);
}
