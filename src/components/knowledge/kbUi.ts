import type { SemanticIconName } from "../../lib/icons/types";
import { readKb, type KbKind, type KbMeta } from "../../lib/kb";
import type { EntryMeta } from "../../types/entry";
import { useEntryStore } from "../../stores/entryStore";
import { focusSession } from "../../lib/focusSession";
import { useArticleTabsStore } from "../../stores/articleTabsStore";
import { openDashboardForEntry, openFolderView, openKnowledgeView } from "../../lib/openDashboard";
import { KNOWLEDGE_SESSION_ID, entryInfoSessionId, folderViewSessionId } from "../../lib/dashboardSessions";

export const KIND_META: Readonly<Record<KbKind, { label: string; plural: string; icon: SemanticIconName }>> = {
  overview: { label: "Overview", plural: "Overview", icon: "infoCircle" },
  facts: { label: "Facts", plural: "Facts", icon: "database" },
  procedure: { label: "Procedure", plural: "Procedures", icon: "listNumbers" },
  troubleshooting: { label: "Troubleshooting", plural: "Troubleshooting", icon: "alertTriangle" },
  contact: { label: "Contact", plural: "Contacts", icon: "users" },
  playbook: { label: "Playbook", plural: "Playbooks", icon: "stack" },
  changelog: { label: "Change log", plural: "Change log", icon: "history" },
};

export const NEW_ARTICLE_KINDS: readonly KbKind[] = ["overview", "procedure", "troubleshooting", "facts", "contact", "playbook"];

export const TEMPLATES: Readonly<Record<KbKind, string>> = {
  overview: "## What it is\n\n## What matters most\n\n## Where things are\n",
  facts: "| Item | Value |\n| --- | --- |\n| OS | |\n| Role | |\n",
  procedure: "## When to use\n\n## Steps\n1. \n2. \n\n## Check it worked\n",
  troubleshooting: "## Symptom\n\n## Cause\n\n## Fix\n",
  contact: "| Who | Role | How to reach |\n| --- | --- | --- |\n| | | |\n",
  playbook: "## Applies to\n\n## Steps\n1. \n",
  changelog: "# Change log\n",
};

export interface ArticleItem {
  entry: EntryMeta;
  kb: KbMeta;
}

export function articleOf(entry: EntryMeta | undefined): ArticleItem | null {
  if (!entry || entry.entry_type !== "document") return null;
  const kb = readKb(entry.config);
  return kb ? { entry, kb } : null;
}

export function editorLabel(kb: KbMeta): string {
  const e = kb.last_editor ?? { ...kb.author, at: "" };
  return e.kind === "agent" ? (e.name ?? "An AI agent") : "You";
}

export function contentOf(entry: EntryMeta): string {
  const c = (entry.config as { content?: unknown }).content;
  return typeof c === "string" ? c : "";
}

/** The dashboard tab an article belongs in when it is opened from outside one: its asset, folder, or the Knowledge page. */
function ownerHost(entry: EntryMeta): string {
  const kb = readKb(entry.config);
  if (kb?.scope === "asset" && entry.parent_entry_id && useEntryStore.getState().entries.some((e) => e.id === entry.parent_entry_id)) {
    openDashboardForEntry(entry.parent_entry_id);
    return entryInfoSessionId(entry.parent_entry_id);
  }
  if (kb?.scope === "folder" && entry.folder_id) {
    openFolderView(entry.folder_id);
    return folderViewSessionId(entry.folder_id);
  }
  openKnowledgeView();
  return KNOWLEDGE_SESSION_ID;
}

/** Opens an article as a sub-tab of `host` (the dashboard tab it was opened from), or of its owner's tab. */
export function openArticle(id: string, host?: string): void {
  const entry = useEntryStore.getState().hiddenEntries.find((e) => e.id === id);
  if (!entry) return;
  const target = host ?? ownerHost(entry);
  useArticleTabsStore.getState().openTab(target, id);
  focusSession(target);
}
