import { useCallback, useEffect, useState } from "react";
import { LoaderIcon, TrashIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import ConfirmDialog from "../common/ConfirmDialog";
import type { RecentlyDeletedItem, SyncRowKey } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { deviceNameOr, formatAgo, plural } from "./sync-copy";

type PendingDelete = { readonly rows: readonly SyncRowKey[] } | { readonly all: true } | null;

function ItemRow({ item, checked, onToggle }: { item: RecentlyDeletedItem; checked: boolean; onToggle: () => void }) {
  const by = item.deviceName ? ` on ${deviceNameOr(item.deviceName)}` : "";
  return (
    <label className={`flex items-center gap-3 py-2 border-b border-stroke-dim last:border-b-0 ${item.redacted ? "opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked} disabled={item.redacted} onChange={onToggle} className="accent-conduit-500" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate">{item.title}</p>
        <p className="text-xs text-ink-muted">
          {item.redacted ? "Erased permanently" : `Deleted ${formatAgo(item.diedMs)}${by}`}
          {item.entryType ? ` · ${item.entryType}` : ""}
        </p>
      </div>
    </label>
  );
}

/** A list that could not load says so and offers another try, instead of looking empty. */
export function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <p className="flex-1">Could not load {what}.</p>
      <DialogButton onClick={onRetry}>Try again</DialogButton>
    </div>
  );
}

/** 4.7 "Recently deleted": restore, or delete permanently everywhere. */
export default function RecentlyDeletedPanel() {
  const [items, setItems] = useState<readonly RecentlyDeletedItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useSyncStore.getState().closeView();

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setItems(await syncApi.recentlyDeleted(showAll));
      setSelected(new Set());
    } catch (err) {
      console.error("[sync] Failed to list deleted items:", err);
      toast.error("Could not list deleted items", errorText(err, "Try again."));
      setItems([]);
      setLoadFailed(true);
    }
  }, [showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedRows = (items ?? []).filter((i) => selected.has(rowKeyString(i.row))).map((i) => i.row);
  // Erased rows only keep their "Erased permanently" record; there is nothing left to delete.
  const erasable = (items ?? []).some((i) => !i.redacted);
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const run = async (action: () => Promise<string>, failTitle: string) => {
    setBusy(true);
    try {
      toast.success(await action());
      await load();
    } catch (err) {
      toast.error(failTitle, errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };
  const restore = () => run(async () => {
    await syncApi.restoreDeleted(selectedRows);
    return `Restored ${plural(selectedRows.length, "item")}.`;
  }, "Could not restore");
  const erase = (target: Exclude<PendingDelete, null>) => run(async () => {
    await ("all" in target ? syncApi.deletePermanently(null, true) : syncApi.deletePermanently(target.rows, false));
    return "Deleted permanently.";
  }, "Could not delete");

  return (
    <>
      <SyncDialogFrame
        icon={TrashIcon}
        title="Recently deleted"
        width="w-[560px]"
        onEscape={() => (pendingDelete ? setPendingDelete(null) : close())}
        footer={
          <>
            <DialogButton variant="danger" disabled={busy || selectedRows.length === 0} onClick={() => setPendingDelete({ rows: selectedRows })}>Delete permanently</DialogButton>
            <DialogButton disabled={busy || !erasable} onClick={() => setPendingDelete({ all: true })}>Delete all permanently</DialogButton>
            <DialogButton variant="primary" disabled={busy || selectedRows.length === 0} onClick={() => void restore()}>Restore</DialogButton>
            <DialogButton onClick={close}>Done</DialogButton>
          </>
        }
      >
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-conduit-500" />
          Show items deleted more than 30 days ago
        </label>
        {items === null ? (
          <div className="flex items-center gap-2"><LoaderIcon size={16} className="animate-spin" /> Loading...</div>
        ) : loadFailed ? (
          <LoadFailed what="the deleted items" onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <p>Nothing was deleted recently.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {items.map((i) => <ItemRow key={rowKeyString(i.row)} item={i} checked={selected.has(rowKeyString(i.row))} onToggle={() => toggle(rowKeyString(i.row))} />)}
          </div>
        )}
      </SyncDialogFrame>
      {pendingDelete && (
        <div className="relative z-[70]">
          <ConfirmDialog
            title="Delete permanently?"
            message="This erases the items on every device that syncs this vault. It can't be undone."
            confirmLabel="Delete permanently"
            variant="danger"
            onConfirm={() => {
              const target = pendingDelete;
              setPendingDelete(null);
              void erase(target);
            }}
            onCancel={() => setPendingDelete(null)}
          />
        </div>
      )}
    </>
  );
}
