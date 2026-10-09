import { useMemo } from "react";
import { knowledgeFor, type InheritedArticle } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import type { EntryMeta } from "../../types/entry";

/** The articles that apply to an asset or folder, in contract order (docs/KNOWLEDGE_BASE.md 4). */
export function useKnowledge(target: { entry_id: string } | { folder_id: string }): InheritedArticle<EntryMeta>[] {
  const entries = useEntryStore((s) => s.entries);
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const folders = useEntryStore((s) => s.folders);
  const entryId = "entry_id" in target ? target.entry_id : null;
  const folderId = "folder_id" in target ? target.folder_id : null;
  return useMemo(
    () => knowledgeFor(entryId ? { entry_id: entryId } : { folder_id: folderId! }, [...entries, ...hiddenEntries], folders),
    [entryId, folderId, entries, hiddenEntries, folders],
  );
}
