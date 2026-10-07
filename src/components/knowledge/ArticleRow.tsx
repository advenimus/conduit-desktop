import { IconSlot } from "../ui";
import { formatRelativeTime } from "../dashboard/relativeTime";
import { hasUnseenAgentEdit, isStale } from "../../lib/kb";
import { editorLabel, KIND_META, openArticle, type ArticleItem } from "./kbUi";

interface ArticleRowProps extends ArticleItem {
  /** Shown before the title, e.g. the folder an inherited article comes from. */
  context?: string | null;
}

/** One article in a Knowledge list: kind, title, summary, who edited it when, and its state. */
export default function ArticleRow({ entry, kb, context }: ArticleRowProps) {
  // A change log changes every time something is logged; it is not something to review.
  const unseen = kb.kind !== "changelog" && hasUnseenAgentEdit(kb);
  const stale = isStale(kb, entry.updated_at, new Date().toISOString());
  const kind = KIND_META[kb.kind] ?? KIND_META.facts;
  return (
    <button
      type="button"
      onClick={() => openArticle(entry.id)}
      className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left hover:bg-hover"
      data-cv-kb-article={entry.id}
    >
      <IconSlot icon={kind.icon} className="mt-0.5 shrink-0 text-ink-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {context && <span className="shrink-0 text-label text-ink-faint">{context} ·</span>}
          <span className="truncate text-body text-ink">{entry.name}</span>
          {kb.pinned && <IconSlot icon="pinFilled" size={12} className="shrink-0 text-ink-faint" />}
          {unseen && <span className="size-2 shrink-0 rounded-full bg-info" title="Edited by an agent; not reviewed yet" aria-label="Not reviewed" />}
        </span>
        {kb.summary && <span className="block truncate text-label text-ink-muted">{kb.summary}</span>}
        <span className="block text-meta text-ink-faint">
          {editorLabel(kb)} · {formatRelativeTime(entry.updated_at)}
          {kb.status === "needs_review" && <span className="text-warning"> · needs review</span>}
          {kb.verified_at && !stale && <span className="text-success"> · verified</span>}
          {stale && kb.kind !== "changelog" && <span className="text-warning"> · not checked in 90 days</span>}
        </span>
      </span>
    </button>
  );
}
