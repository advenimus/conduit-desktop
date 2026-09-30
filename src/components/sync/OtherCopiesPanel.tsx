import { useCallback, useEffect, useState } from "react";
import { FileIcon, LoaderIcon, RefreshIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { CopyAction, CopyClass, CopyInfo } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { LoadFailed } from "./RecentlyDeletedPanel";
import { smallButton } from "./ConflictFieldRow";
import { copyAction } from "./prompt-actions";
import { plural } from "./sync-copy";

interface ClassSpec {
  readonly text: (c: CopyInfo) => string;
  readonly actions: readonly { readonly label: string; readonly action: CopyAction; readonly primary?: boolean }[];
}

const CLASS_SPECS: Readonly<Record<CopyClass, ClassSpec>> = {
  "in-use-elsewhere": {
    text: () => "Another device syncs this copy.",
    actions: [{ label: "Merge them...", action: "merge", primary: true }, { label: "Keep separate", action: "separate" }],
  },
  "nothing-new": {
    text: () => "Nothing new. Everything in it is already in your vault.",
    actions: [{ label: "Move to Trash", action: "trash" }, { label: "Ignore", action: "ignore" }],
  },
  "safe-provider-copy": {
    text: () => "A cloud drive conflict copy. Its changes were merged.",
    actions: [{ label: "Move to Trash", action: "trash" }],
  },
  "needs-review": {
    text: (c) =>
      `${plural(c.changes, "change")} not in your vault${c.deletions > 0 ? `, including ${plural(c.deletions, "deletion")}` : ""}.`,
    actions: [{ label: "Review...", action: "review", primary: true }, { label: "Ignore this copy", action: "ignore" }],
  },
};

function CopyRow({ copy, onDone }: { copy: CopyInfo; onDone: () => void }) {
  const spec = CLASS_SPECS[copy.cls];
  const [busy, setBusy] = useState(false);
  const act = async (action: CopyAction) => {
    setBusy(true);
    await copyAction(copy, action);
    setBusy(false);
    onDone();
  };
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-stroke-dim last:border-b-0">
      <FileIcon size={16} className="text-ink-muted mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate" title={copy.path}>{copy.name}</p>
        <p className="text-xs text-ink-muted">{spec.text(copy)}</p>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {spec.actions.map((a) => (
          <button key={a.action} type="button" disabled={busy} onClick={() => void act(a.action)} className={smallButton(a.primary)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Spec 5.8: other files of this vault in the same folder. Nothing moves without a click. */
export default function OtherCopiesPanel() {
  const [copies, setCopies] = useState<readonly CopyInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const close = () => useSyncStore.getState().closeView();

  const load = useCallback(async (rescan: boolean) => {
    setLoadFailed(false);
    try {
      setCopies(await syncApi.listCopies(rescan));
    } catch (err) {
      console.error("[sync] Failed to list copies:", err);
      toast.error("Could not list copies", errorText(err, "Try again."));
      setCopies([]);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <SyncDialogFrame
      icon={FileIcon}
      title="Other copies of this vault"
      width="w-[600px]"
      onEscape={close}
      footer={
        <>
          <DialogButton onClick={() => { setCopies(null); void load(true); }}>
            <span className="flex items-center gap-1.5"><RefreshIcon size={14} /> Scan again</span>
          </DialogButton>
          <DialogButton variant="primary" onClick={close}>Done</DialogButton>
        </>
      }
    >
      {copies === null ? (
        <div className="flex items-center gap-2"><LoaderIcon size={16} className="animate-spin" /> Looking for copies...</div>
      ) : loadFailed ? (
        <LoadFailed what="the copies" onRetry={() => void load(true)} />
      ) : copies.length === 0 ? (
        <p>No other copies in this vault's folder.</p>
      ) : (
        <div>{copies.map((c) => <CopyRow key={c.path} copy={c} onDone={() => void load(false)} />)}</div>
      )}
    </SyncDialogFrame>
  );
}
