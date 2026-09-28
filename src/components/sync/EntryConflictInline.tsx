import { useMemo } from "react";
import { IconSlot } from "../ui";
import { useSyncStore } from "../../stores/syncStore";
import { groupsForRow } from "../../stores/sync-reducers";
import type { FieldConflict } from "../../types/sync";
import ConflictFieldRow from "./ConflictFieldRow";
import SmallButton from "./SmallButton";

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
      <div className="flex items-center gap-2 border-b border-warning-border bg-warning-bg px-4 py-2 text-label text-warning">
        <IconSlot icon="alertTriangle" className="shrink-0" />
        <span className="flex-1">
          {names ? `Other devices saved different values for: ${names}.` : "Other devices changed this item."} Fields you change here replace the other versions.
        </span>
        <SmallButton onClick={openReview}>Review</SmallButton>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-b border-stroke bg-warning-bg px-6 py-4">
      <div className="flex items-center gap-2">
        <IconSlot icon="alertTriangle" className="text-warning" />
        <span className="flex-1 text-body font-semibold text-ink">Your devices saved different versions</span>
        <SmallButton onClick={openReview}>Open review</SmallButton>
      </div>
      {fields.map((f) => (
        <ConflictFieldRow key={`${f.key.rowId}:${f.key.reg}`} field={f} itemTitle={title} compact />
      ))}
      {fields.length === 0 && <p className="text-label text-ink-muted">Other devices changed this item in different ways. Open the review to decide.</p>}
    </div>
  );
}
