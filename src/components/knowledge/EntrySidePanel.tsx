import { useId, useState } from "react";
import type { EntryMeta } from "../../types/entry";
import MarkdownRenderer from "../markdown/MarkdownRenderer";
import { TabPanel, Tabs, type TabItem } from "../ui";
import KnowledgePanel from "./KnowledgePanel";
import { useKnowledge } from "./useKnowledge";

type SideTab = "knowledge" | "notes";

/** The right side of an asset page: its knowledge articles and its notes. */
export default function EntrySidePanel({ entry }: { entry: EntryMeta }) {
  const idBase = useId();
  const knowledge = useKnowledge({ entry_id: entry.id });
  const own = knowledge.filter((k) => k.group === "asset").length;
  const hasNotes = !!entry.notes?.trim();
  const [tab, setTab] = useState<SideTab>(own > 0 || !hasNotes ? "knowledge" : "notes");

  const items: ReadonlyArray<TabItem<SideTab>> = [
    { value: "knowledge", label: knowledge.length ? `Knowledge (${knowledge.length})` : "Knowledge", icon: "notes" },
    { value: "notes", label: "Notes", icon: "fileText" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs idBase={idBase} items={items} value={tab} onChange={setTab} variant="underline" className="px-6" />
      <TabPanel idBase={idBase} value={tab} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 allow-select">
        {tab === "knowledge" ? (
          <KnowledgePanel target={{ entryId: entry.id }} />
        ) : hasNotes ? (
          <MarkdownRenderer content={entry.notes!} />
        ) : (
          <p className="text-body text-ink-muted">No notes. Edit the entry to add some, or keep what you know as knowledge articles.</p>
        )}
      </TabPanel>
    </div>
  );
}
