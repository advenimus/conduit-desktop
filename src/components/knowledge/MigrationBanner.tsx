import { useState } from "react";
import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { migrationSuggestion } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import type { EntryMeta } from "../../types/entry";
import { toast } from "../common/Toast";
import { Banner } from "../ui";

const ASK_AGENT_PROMPT = (name: string) =>
  `The notes on "${name}" look like a knowledge base. Please organize them into knowledge articles with kb_import_notes (one topic per article, keep secret refs and tokens exactly), and keep the notes.`;

/** Offers to move notes that look like a knowledge base into articles (docs/KNOWLEDGE_BASE.md 7). */
export default function MigrationBanner({ entry, ownArticles }: { entry: EntryMeta; ownArticles: number }) {
  const loadAll = useEntryStore((s) => s.loadAll);
  const [busy, setBusy] = useState(false);
  const reason = migrationSuggestion(entry.notes, ownArticles, (entry.config as { kb_migration_dismissed?: boolean }).kb_migration_dismissed === true);
  if (!reason) return null;

  const run = async (command: string, args: Record<string, unknown>, done?: (n: number) => string) => {
    setBusy(true);
    try {
      const n = await invoke<number>(command, args);
      await loadAll();
      if (done) toast.success(done(n));
    } catch (err) {
      toast.error(errorText(err, "Couldn't update the notes"));
    } finally {
      setBusy(false);
    }
  };

  const askAgent = () => {
    void navigator.clipboard.writeText(ASK_AGENT_PROMPT(entry.name)).catch(() => undefined);
    document.dispatchEvent(new CustomEvent("conduit:ai-prompt", { detail: { prompt: ASK_AGENT_PROMPT(entry.name), entryId: entry.id } }));
    toast.info("Prompt copied. Paste it into the agent chat.");
  };

  return (
    <Banner
      tone="info"
      icon="notes"
      actions={[
        { label: "Ask the agent", onClick: askAgent, disabled: busy },
        {
          label: "Split by headings",
          onClick: () => void run("kb_split_notes", { entry_id: entry.id, notes_after: "keep" }, (n) => `${n} ${n === 1 ? "article" : "articles"} created; the notes are unchanged`),
          disabled: busy,
          primary: true,
        },
        { label: "Dismiss", onClick: () => void run("kb_dismiss_migration", { entry_id: entry.id }), disabled: busy },
      ]}
    >
      These notes look like a knowledge base. Move them into articles?
    </Banner>
  );
}
