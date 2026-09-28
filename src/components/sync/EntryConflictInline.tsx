import { useMemo } from "react";
import { AlertTriangleIcon } from "../../lib/icons";
import { useSyncStore } from "../../stores/syncStore";
import { groupsForRow } from "../../stores/sync-reducers";
import type { FieldConflict } from "../../types/sync";
import ConflictFieldRow, { smallButton } from "./ConflictFieldRow";

interface EntryConflictInlineProps {
  entryId: string;
  /** Editor: list the fields only; saving an edited field resolves it. */
  mode: "detail" | "editor";
}

function fieldsOf(items: ReturnType<typeof groupsForRow>): FieldConflict[] {
  return items.flatMap((g) =>
    g.items.flatMap((item) => (item.kind === "field" ? [item.field] : item.kind === "appearance" ? [...item.fields] : [])),
  );
}

/** Conflicted fields of one entry, shown in the entry detail and the editor (7.2). */
export default function EntryConflictInline({ entryId, mode }: EntryConflictInlineProps) {
  const conflicts = useSyncStore((s) => s.conflicts);
  const groups = useMemo(() => groupsForRow(conflicts, { tbl: 1, rowId: entryId }), [conflicts, entryId]);
  if (groups.length === 0) return null;
  const fields = fieldsOf(groups);
  const title = groups[0]?.title ?? "";
  const openReview = () => useSyncStore.getState().openView({ kind: "review", row: { tbl: 1, rowId: entryId } });

  if (mode === "editor") {
    const names = fields.map((f) => f.label).join(", ");
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-300">
        <AlertTriangleIcon size={14} className="flex-shrink-0" />
        <span className="flex-1">
          {names ? `Other devices saved different values for: ${names}.` : "Other devices changed this item."} Fields you change here replace the other versions.
        </span>
        <button type="button" onClick={openReview} className={smallButton()}>Review</button>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 border-b border-stroke space-y-2 bg-amber-500/5">
      <div className="flex items-center gap-2">
        <AlertTriangleIcon size={16} className="text-amber-400" />
        <span className="text-sm font-medium text-ink flex-1">Your devices saved different versions</span>
        <button type="button" onClick={openReview} className={smallButton()}>Open review</button>
      </div>
      {fields.map((f) => (
        <ConflictFieldRow key={`${f.key.rowId}:${f.key.reg}`} field={f} itemTitle={title} compact />
      ))}
      {fields.length === 0 && <p className="text-xs text-ink-muted">Other devices changed this item in different ways. Open the review to decide.</p>}
    </div>
  );
}
