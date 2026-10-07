import { useMemo } from "react";
import { openKnowledgeView } from "../../../lib/openDashboard";
import { hasUnseenAgentEdit, readKb } from "../../../lib/kb";
import { useEntryStore } from "../../../stores/entryStore";
import { Button, Card, SectionHeader } from "../../ui";
import ArticleRow from "../../knowledge/ArticleRow";

const SHOWN = 5;

/** What agents recently wrote into the knowledge base, and how much of it is waiting for review. */
export default function AgentLearningsCard({ className }: { className?: string }) {
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const entries = useEntryStore((s) => s.entries);

  const { recent, unseen } = useMemo(() => {
    const byAgent = hiddenEntries
      .map((entry) => ({ entry, kb: readKb(entry.config) }))
      .filter((a): a is { entry: typeof a.entry; kb: NonNullable<typeof a.kb> } =>
        !!a.kb && a.entry.entry_type === "document" && a.kb.status !== "archived" && a.kb.last_editor?.kind === "agent")
      .sort((a, b) => (a.kb.last_editor!.at < b.kb.last_editor!.at ? 1 : -1));
    return { recent: byAgent.slice(0, SHOWN), unseen: byAgent.filter((a) => a.kb.kind !== "changelog" && hasUnseenAgentEdit(a.kb)).length };
  }, [hiddenEntries]);

  if (recent.length === 0) return null;
  const assetName = (id: string | null) => entries.find((e) => e.id === id)?.name ?? null;

  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-2">
        <SectionHeader
          title="Agent learnings"
          description={unseen ? `${unseen} ${unseen === 1 ? "edit" : "edits"} waiting for your review` : "Recent knowledge written by AI agents"}
        />
        <Button size="sm" onClick={openKnowledgeView}>
          {unseen ? "Review" : "All knowledge"}
        </Button>
      </div>
      {recent.map((a) => (
        <ArticleRow key={a.entry.id} entry={a.entry} kb={a.kb} context={a.kb.scope === "asset" ? assetName(a.entry.parent_entry_id) : a.kb.scope === "vault" ? "Vault" : null} />
      ))}
    </Card>
  );
}
