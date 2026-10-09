import { useMemo } from "react";
import { hasUnseenAgentEdit, readKb } from "../../lib/kb";
import { NotesIcon } from "../../lib/icons";
import { useEntryStore } from "../../stores/entryStore";

export interface KnowledgeCount {
  count: number;
  unseen: boolean;
}

/** Articles per asset (by parent) and per folder (folder articles), for the sidebar badges. */
export function useKnowledgeCounts(): Map<string, KnowledgeCount> {
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  return useMemo(() => {
    const counts = new Map<string, KnowledgeCount>();
    for (const e of hiddenEntries) {
      const kb = e.entry_type === "document" ? readKb(e.config) : null;
      if (!kb || kb.status === "archived" || kb.kind === "changelog") continue;
      const owner = kb.scope === "asset" ? e.parent_entry_id : kb.scope === "folder" ? e.folder_id : null;
      if (!owner) continue;
      const prev = counts.get(owner) ?? { count: 0, unseen: false };
      counts.set(owner, { count: prev.count + 1, unseen: prev.unseen || hasUnseenAgentEdit(kb) });
    }
    return counts;
  }, [hiddenEntries]);
}

export default function KnowledgeBadge({ info }: { info: KnowledgeCount | undefined }) {
  if (!info) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 text-meta text-ink-faint"
      title={`${info.count} knowledge ${info.count === 1 ? "article" : "articles"}${info.unseen ? ", agent edits to review" : ""}`}
      data-cv-kb-badge={info.count}
    >
      <NotesIcon size={12} />
      {info.count}
      {info.unseen && <span className="size-1.5 rounded-full bg-info" />}
    </span>
  );
}
