import { useCallback, useEffect, useState } from "react";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import ConfirmDialog from "../common/ConfirmDialog";
import type { RecentlyDeletedItem, SyncRowKey } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { Checkbox, Spinner } from "../ui";
import { deviceNameOr, formatAgo, plural } from "./sync-copy";

type PendingDelete = { readonly rows: readonly SyncRowKey[] } | { readonly all: true } | null;

function ItemRow({ item, checked, onToggle }: { item: RecentlyDeletedItem; checked: boolean; onToggle: () => void }) {
  const by = item.deviceName ? ` on ${deviceNameOr(item.deviceName)}` : "";
  return (
    <Checkbox
      checked={checked}
      disabled={item.redacted}
      onChange={onToggle}
      className="w-full border-b border-stroke-dim py-2 last:border-b-0"
      description={
        <span data-cv-row-detail="">
          {item.redacted ? "Erased permanently" : `Deleted ${formatAgo(item.diedMs)}${by}`}
          {item.entryType ? ` · ${item.entryType}` : ""}
        </span>
      }
    >
      <span data-cv-row-title="" className="block truncate text-ink">
        {item.title}
      </span>
    </Checkbox>
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
        icon="trash"
        title="Recently deleted"
        width={560}
        onEscape={close}
        footer={
          <>
            <DialogButton variant="danger" disabled={busy || selectedRows.length === 0} onClick={() => setPendingDelete({ rows: selectedRows })}>Delete permanently</DialogButton>
            <DialogButton disabled={busy || !erasable} onClick={() => setPendingDelete({ all: true })}>Delete all permanently</DialogButton>
            <DialogButton variant="primary" disabled={busy || selectedRows.length === 0} onClick={() => void restore()}>Restore</DialogButton>
            <DialogButton onClick={close}>Done</DialogButton>
          </>
        }
      >
        <Checkbox checked={showAll} onChange={setShowAll}>
          Show items deleted more than 30 days ago
        </Checkbox>
        {items === null ? (
          <Spinner text="Loading..." />
        ) : loadFailed ? (
          <LoadFailed what="the deleted items" onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <p>Nothing was deleted recently.</p>
        ) : (
          <div data-cv-deleted-list="" className="max-h-80 overflow-y-auto">
            {items.map((i) => <ItemRow key={rowKeyString(i.row)} item={i} checked={selected.has(rowKeyString(i.row))} onToggle={() => toggle(rowKeyString(i.row))} />)}
          </div>
        )}
      </SyncDialogFrame>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete permanently?"
          message="This erases the items on every device that syncs this vault. It can't be undone."
          confirmLabel="Delete permanently"
          variant="danger"
          layer="stacked"
          closeOnEscape
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void erase(target);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
