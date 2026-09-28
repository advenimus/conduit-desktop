import { useSyncStore } from "../../stores/syncStore";

interface ConflictDotProps {
  /** 1 entries, 2 folders. */
  tbl: 1 | 2;
  rowId: string;
}

/** Amber dot on tree items with a conflict (7.2). Click opens the review for that item. */
export default function ConflictDot({ tbl, rowId }: ConflictDotProps) {
  const has = useSyncStore((s) => s.conflictKeys.has(`${tbl}:${rowId}`));
  if (!has) return null;
  return (
    <span
      role="button"
      tabIndex={-1}
      title="Changes from your other devices need review"
      onClick={(e) => {
        e.stopPropagation();
        useSyncStore.getState().openView({ kind: "review", row: { tbl, rowId } });
      }}
      className="inline-block w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0 cursor-pointer"
    />
  );
}
