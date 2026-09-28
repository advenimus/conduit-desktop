import { useCallback, useEffect, useState } from "react";
import { IconSlot, Spinner } from "../ui";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { CopyAction, CopyClass, CopyInfo } from "../../types/sync";
import SyncDialogFrame, { DialogButton } from "./SyncDialogFrame";
import { LoadFailed } from "./RecentlyDeletedPanel";
import SmallButton from "./SmallButton";
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
    <div data-cv-copy-row="" className="flex items-start gap-3 border-b border-stroke-dim py-2.5 last:border-b-0">
      <IconSlot icon="file" className="mt-px shrink-0 text-ink-muted" />
      <div className="min-w-0 flex-1">
        <p data-cv-row-title="" className="truncate text-body text-ink" title={copy.path}>{copy.name}</p>
        <p data-cv-row-detail="" className="text-label text-ink-muted">{spec.text(copy)}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {spec.actions.map((a) => (
          <SmallButton key={a.action} primary={a.primary} disabled={busy} onClick={() => void act(a.action)}>
            {a.label}
          </SmallButton>
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
      icon="file"
      title="Other copies of this vault"
      width={600}
      onEscape={close}
      footer={
        <>
          <DialogButton icon="refresh" onClick={() => { setCopies(null); void load(true); }}>
            Scan again
          </DialogButton>
          <DialogButton variant="primary" onClick={close}>Done</DialogButton>
        </>
      }
    >
      {copies === null ? (
        <Spinner text="Looking for copies..." />
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
