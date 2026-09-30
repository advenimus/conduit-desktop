import { useEffect, useState } from "react";
import { HistoryIcon, LoaderIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { SnapshotSummary, SyncRegKey, SyncRowKey, UndoPreview } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { LoadFailed } from "./RecentlyDeletedPanel";
import { deviceNameOr, plural } from "./sync-copy";

/** "MacBook deleted 42 items." */
export function massChangeTitle(s: SnapshotSummary): string {
  const by = deviceNameOr(s.byDeviceName, "Another device");
  if (s.deleted > 0) return `${by} deleted ${plural(s.deleted, "item")}.`;
  return `${by} changed ${plural(s.changedRows, "item")}.`;
}

function regKeyString(k: SyncRegKey): string {
  return `${k.tbl}:${k.rowId}:${k.reg}`;
}

interface LoadedUndo {
  readonly snapshot: SnapshotSummary;
  readonly preview: UndoPreview;
}

async function loadUndo(noticeId: string): Promise<LoadedUndo | null> {
  const snapshots = await syncApi.listSnapshots();
  const snapshot = snapshots.find((s) => s.noticeId === noticeId);
  if (!snapshot) return null;
  return { snapshot, preview: await syncApi.undoPreview(snapshot.id) };
}

/** 5.10 targeted undo: re-create the rows a merge deleted and, optionally, restore changed fields. */
export default function MassChangeNotice({ noticeId }: { noticeId: string }) {
  const [loaded, setLoaded] = useState<LoadedUndo | null | undefined>(undefined);
  const [rows, setRows] = useState<ReadonlySet<string>>(new Set());
  const [fields, setFields] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const close = () => useSyncStore.getState().closeView();

  useEffect(() => {
    setLoadFailed(false);
    loadUndo(noticeId)
      .then((l) => {
        setLoaded(l);
        if (l) setRows(new Set(l.preview.rows.filter((r) => r.stillDeleted).map((r) => rowKeyString(r.row))));
      })
      .catch((err) => {
        console.error("[sync] Failed to load the undo preview:", err);
        toast.error("Could not load the change", errorText(err, "Try again."));
        setLoaded(null);
        setLoadFailed(true);
      });
  }, [noticeId, attempt]);

  const flip = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const keepChanges = async () => {
    try {
      await useSyncStore.getState().dismissNotice(noticeId);
    } catch (err) {
      console.error("[sync] Failed to dismiss notice:", err);
    }
    close();
  };

  const undo = async () => {
    if (!loaded) return;
    setBusy(true);
    try {
      const rowKeys: SyncRowKey[] = loaded.preview.rows.filter((r) => rows.has(rowKeyString(r.row))).map((r) => r.row);
      const fieldKeys: SyncRegKey[] = loaded.preview.fields.filter((f) => fields.has(regKeyString(f.key))).map((f) => f.key);
      const res = await syncApi.undoApply(loaded.snapshot.id, rowKeys, fieldKeys);
      toast.success(`Undid ${plural(res.applied, "change")}.`);
      await keepChanges();
    } catch (err) {
      toast.error("Could not undo", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const title = loaded ? massChangeTitle(loaded.snapshot) : "Large change from a sync";
  return (
    <SyncDialogFrame
      icon={HistoryIcon}
      tone="warn"
      title={title}
      width="w-[520px]"
      onEscape={close}
      footer={
        <>
          <DialogButton onClick={close} disabled={busy}>Later</DialogButton>
          <DialogButton onClick={() => void keepChanges()} disabled={busy}>Keep changes</DialogButton>
          <DialogButton variant="primary" onClick={() => void undo()} disabled={busy || !loaded || rows.size + fields.size === 0}>Undo selected</DialogButton>
        </>
      }
    >
      {loaded === undefined && <div className="flex items-center gap-2"><LoaderIcon size={16} className="animate-spin" /> Loading...</div>}
      {loaded === null && loadFailed && <LoadFailed what="this change" onRetry={() => setAttempt((n) => n + 1)} />}
      {loaded === null && !loadFailed && <p>The saved copy for this change is no longer available, so it can't be undone here.</p>}
      {loaded && (
        <>
          <p>Undo only changes what you select. Nothing else changes.</p>
          {loaded.preview.rows.length > 0 && <p className="text-xs font-medium text-ink">Deleted items</p>}
          <div className="max-h-48 overflow-y-auto">
            {loaded.preview.rows.map((r) => (
              <label key={rowKeyString(r.row)} className="flex items-center gap-2 py-1 text-xs cursor-pointer">
                <input type="checkbox" disabled={!r.stillDeleted} checked={rows.has(rowKeyString(r.row))} onChange={() => setRows(flip(rows, rowKeyString(r.row)))} className="accent-conduit-500" />
                <span className="text-ink">{r.title}</span>
                {!r.stillDeleted && <span className="text-ink-muted">(already back)</span>}
              </label>
            ))}
          </div>
          {loaded.preview.fields.length > 0 && <p className="text-xs font-medium text-ink">Changed fields (optional)</p>}
          <div className="max-h-40 overflow-y-auto">
            {loaded.preview.fields.map((f) => (
              <label key={regKeyString(f.key)} className="flex items-center gap-2 py-1 text-xs cursor-pointer">
                <input type="checkbox" disabled={!f.stillMerged} checked={fields.has(regKeyString(f.key))} onChange={() => setFields(flip(fields, regKeyString(f.key)))} className="accent-conduit-500" />
                <span className="text-ink">{f.label}</span>
                {!f.stillMerged && <span className="text-ink-muted">(changed again since)</span>}
              </label>
            ))}
          </div>
        </>
      )}
    </SyncDialogFrame>
  );
}
