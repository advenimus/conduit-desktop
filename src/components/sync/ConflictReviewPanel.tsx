import { useEffect, useMemo, useState } from "react";
import { errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { orderGroups, rowKeyString } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { ConflictGroup, SyncRowKey } from "../../types/sync";
import { Button, Dialog, DialogHeader, IconSlot, ListRow, cx } from "../ui";
import ConflictItemView from "./ConflictItemView";
import SyncNoticeList from "./SyncNoticeList";
import { plural } from "./sync-copy";

const REVIEW_TITLE = "Review changes";
const PANEL_WIDTH = 896;
const PANEL_SIZE = { height: 600, maxHeight: "90vh" } as const;

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
    <div className="w-60 shrink-0 space-y-0.5 overflow-y-auto border-r border-stroke p-2">
      {groups.map((g) => {
        const key = rowKeyString(g.row);
        return (
          <ListRow
            key={key}
            selected={selected === key}
            onClick={() => onSelect(key)}
            leading={<span className={cx("size-1.5 rounded-full", g.snoozed ? "bg-ink-faint" : "bg-warning")} />}
            meta={g.snoozed ? <IconSlot icon="clock" size={12} compact /> : g.items.length}
          >
            {g.title}
          </ListRow>
        );
      })}
    </div>
  );
}

function GroupDetail({ group }: { group: ConflictGroup }) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-body font-semibold text-ink">{group.title}</h3>
        {group.snoozed && <p className="mt-0.5 text-label text-ink-muted">Snoozed on this device. The newest version is in use.</p>}
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

  useEffect(() => {
    void useSyncStore.getState().loadConflicts();
  }, []);

  // In place, like SyncDialogFrame: SyncLayer's sibling order keeps the timed dialogs above this panel.
  return (
    <Dialog
      open
      title={REVIEW_TITLE}
      icon="alertTriangle"
      tone="warn"
      width={PANEL_WIDTH}
      style={PANEL_SIZE}
      layer="sync"
      harnessLabel={REVIEW_TITLE}
      portal={false}
      layout="custom"
      onClose={close}
    >
      <DialogHeader className="[&>h2]:flex-none">
        <span className="flex-1 text-label text-ink-muted">{plural(groups.length, "item")}</span>
        <Button size="sm" disabled={groups.length === 0} onClick={() => void bulkResolve("keep-newest-all")}>Keep newest for all</Button>
        <Button size="sm" disabled={groups.length === 0} onClick={() => void bulkResolve("keep-newest-older-apps")}>Keep newest for older-app changes</Button>
      </DialogHeader>
      <div className="px-4"><SyncNoticeList /></div>
      {groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-muted">
          <IconSlot icon="circleCheck" size={28} className="text-success" />
          <p className="text-body">Nothing to review. Every device agrees.</p>
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 border-t border-stroke">
          <GroupList groups={groups} selected={selected} onSelect={setSelected} />
          <div className="flex-1 overflow-y-auto p-4">
            {current ? <GroupDetail group={current} /> : <p className="text-body text-ink-muted">This item was resolved, maybe on another device. Pick another item.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
