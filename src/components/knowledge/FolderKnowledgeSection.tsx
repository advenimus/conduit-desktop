import { useMemo } from "react";
import { effectiveFolderId, folderChain, readKb } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import ArticleRow from "./ArticleRow";
import KnowledgePanel from "./KnowledgePanel";

const RECENT_LEARNINGS = 6;

/** Folder page: the folder's own knowledge, and what agents recently learned about assets inside it. */
export default function FolderKnowledgeSection({ folderId, assetCount }: { folderId: string; assetCount: number }) {
  const entries = useEntryStore((s) => s.entries);
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const folders = useEntryStore((s) => s.folders);

  const recent = useMemo(() => {
    const byId = new Map([...entries, ...hiddenEntries].map((e) => [e.id, e]));
    const inFolder = (assetId: string | null) => !!assetId && folderChain(effectiveFolderId(assetId, byId), folders).includes(folderId);
    return hiddenEntries
      .map((entry) => ({ entry, kb: readKb(entry.config) }))
      .filter((a): a is { entry: typeof a.entry; kb: NonNullable<typeof a.kb> } =>
        !!a.kb && a.kb.scope === "asset" && a.kb.status !== "archived" && a.kb.last_editor?.kind === "agent" && inFolder(a.entry.parent_entry_id))
      .sort((a, b) => (a.kb.last_editor!.at < b.kb.last_editor!.at ? 1 : -1))
      .slice(0, RECENT_LEARNINGS);
  }, [entries, hiddenEntries, folders, folderId]);

  const assetName = (id: string | null) => entries.find((e) => e.id === id)?.name ?? null;

  return (
    <section className="mx-6 mt-4 rounded border border-card-border bg-card p-4" data-cv-folder-knowledge={folderId}>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-body font-semibold text-ink">Knowledge</h3>
        <span className="text-label text-ink-faint">
          Shared with {assetCount} {assetCount === 1 ? "asset" : "assets"} in this folder
        </span>
      </div>
      <KnowledgePanel target={{ folderId }} />
      {recent.length > 0 && (
        <div className="mt-3 border-t border-divider pt-2">
          <h4 className="px-2 text-meta font-semibold uppercase tracking-wide text-ink-faint">Recent agent learnings here</h4>
          {recent.map((a) => (
            <ArticleRow key={a.entry.id} entry={a.entry} kb={a.kb} context={assetName(a.entry.parent_entry_id)} />
          ))}
        </div>
      )}
    </section>
  );
}
