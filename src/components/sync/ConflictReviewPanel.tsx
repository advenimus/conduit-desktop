import { useEffect, useMemo, useState } from "react";
import { AlertTriangleIcon, CheckIcon, ClockIcon, CloseIcon } from "../../lib/icons";
import { errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { orderGroups, rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { ConflictGroup, SyncRowKey } from "../../types/sync";
import ConflictItemView from "./ConflictItemView";
import SyncNoticeList from "./SyncNoticeList";
import { smallButton } from "./ConflictFieldRow";
import { plural } from "./sync-copy";
import { useDialogFocus } from "./SyncDialogFrame";
import { useEscapeLayer } from "./useEscapeLayer";
import { useFreeze } from "../../lib/native-freeze";

type BulkChoice = "keep-newest-all" | "keep-newest-older-apps";

async function bulkResolve(choice: BulkChoice): Promise<void> {
  try {
    const res = await useSyncStore.getState().resolveGroup({ kind: "bulk", choice });
    toast.success(res.conflictCount === 0 ? "All changes resolved." : `${plural(res.conflictCount, "change")} left to review.`);
  } catch (err) {
    toast.error("Could not resolve", errorText(err, "Try again."));
  }
}

function GroupList({ groups, selected, onSelect }: { groups: readonly ConflictGroup[]; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <div className="w-60 border-r border-stroke overflow-y-auto p-2 space-y-0.5 flex-shrink-0">
      {groups.map((g) => {
        const key = rowKeyString(g.row);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded text-left text-sm ${
              selected === key ? "bg-conduit-600/20 text-conduit-400" : "hover:bg-raised text-ink-secondary"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.snoozed ? "bg-ink-faint" : "bg-amber-400"}`} />
            <span className="flex-1 truncate">{g.title}</span>
            {g.snoozed ? <ClockIcon size={12} className="text-ink-faint" /> : <span className="text-[11px] text-ink-muted">{g.items.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

function GroupDetail({ group }: { group: ConflictGroup }) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-ink">{group.title}</h3>
        {group.snoozed && <p className="text-xs text-ink-muted mt-0.5">Snoozed on this device. The newest version is in use.</p>}
      </div>
      {group.items.map((item, i) => (
        <ConflictItemView key={`${rowKeyString(group.row)}-${i}`} item={item} title={group.title} />
      ))}
    </div>
  );
}

function pickInitial(groups: readonly ConflictGroup[], row: SyncRowKey | null): string | null {
  if (row) return rowKeyString(row);
  return groups[0] ? rowKeyString(groups[0].row) : null;
}

/** 7.2 Review panel: groups by item, each field with its versions, bulk "Keep newest". */
export default function ConflictReviewPanel({ initialRow }: { initialRow: SyncRowKey | null }) {
  const rawGroups = useSyncStore((s) => s.conflicts);
  const groups = useMemo(() => orderGroups(rawGroups), [rawGroups]);
  const [selected, setSelected] = useState<string | null>(() => pickInitial(groups, initialRow));
  const current = groups.find((g) => rowKeyString(g.row) === selected) ?? null;
  const close = () => useSyncStore.getState().closeView();
  const content = useDialogFocus();
  useEscapeLayer(close);
  useFreeze(true, "dialog", "Review changes");

  useEffect(() => {
    void useSyncStore.getState().loadConflicts();
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div
        ref={content}
        tabIndex={-1}
        data-dialog-content
        role="dialog"
        aria-modal="true"
        aria-label="Review changes"
        className="w-full max-w-4xl bg-panel rounded-lg shadow-xl flex flex-col h-[600px] max-h-[90vh] mx-4 outline-none"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon size={18} className="text-amber-400" />
            <h2 className="text-lg font-semibold">Review changes</h2>
            <span className="text-xs text-ink-muted">{plural(groups.length, "item")}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={groups.length === 0} onClick={() => void bulkResolve("keep-newest-all")} className={smallButton()}>Keep newest for all</button>
            <button type="button" disabled={groups.length === 0} onClick={() => void bulkResolve("keep-newest-older-apps")} className={smallButton()}>Keep newest for older-app changes</button>
            <button type="button" onClick={close} className="p-1 hover:bg-raised rounded" aria-label="Close"><CloseIcon size={18} /></button>
          </div>
        </div>
        <div className="px-4 pt-3"><SyncNoticeList /></div>
        {groups.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-ink-muted">
            <CheckIcon size={28} className="text-green-400" />
            <p className="text-sm">Nothing to review. Every device agrees.</p>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 mt-3 border-t border-stroke">
            <GroupList groups={groups} selected={selected} onSelect={setSelected} />
            <div className="flex-1 overflow-y-auto p-4">
              {current ? <GroupDetail group={current} /> : <p className="text-sm text-ink-muted">This item was resolved, maybe on another device. Pick another item.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
