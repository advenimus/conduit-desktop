import type { SemanticIconName } from "../../lib/icons/types";
import { readKb, type KbKind, type KbMeta } from "../../lib/kb";
import type { EntryMeta } from "../../types/entry";
import { useSessionStore } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { focusSession } from "../../lib/focusSession";

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

/** Opens an article in a document tab (the article header shows above the body). */
export function openArticle(id: string): void {
  const { sessions, addSession } = useSessionStore.getState();
  if (sessions.some((s) => s.id === id)) {
    focusSession(id);
    return;
  }
  const entry = useEntryStore.getState().hiddenEntries.find((e) => e.id === id);
  if (!entry) return;
  addSession({ id, type: "document", title: entry.name, status: "connected", entryId: id });
}
