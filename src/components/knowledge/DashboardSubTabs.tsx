import { useCallback, useState, type ReactNode } from "react";
import { readKb } from "../../lib/kb";
import { selectArticleTabs, useArticleTabsStore } from "../../stores/articleTabsStore";
import { useEntryStore } from "../../stores/entryStore";
import ConfirmDialog from "../common/ConfirmDialog";
import DocumentView from "../sessions/DocumentView";
import { IconSlot } from "../ui";
import { KIND_META } from "./kbUi";

interface DashboardSubTabsProps {
  /** The dashboard session these articles open inside. */
  host: string;
  homeLabel: string;
  /** Whether the host tab is the visible one, so only it shows an article's editor. */
  visible: boolean;
  children: ReactNode;
}

const TAB = "group flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-t border border-b-0 px-2.5 text-label";

/**
 * Articles opened from a dashboard show as sub-tabs of it, like browser tabs, instead of filling the
 * pane's tab bar. The strip appears once an article is open; the dashboard stays the first tab.
 */
export default function DashboardSubTabs({ host, homeLabel, visible, children }: DashboardSubTabsProps) {
  const { open, active } = useArticleTabsStore(useCallback(selectArticleTabs(host), [host]));
  const activate = useArticleTabsStore((s) => s.activate);
  const closeTab = useArticleTabsStore((s) => s.closeTab);
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  const articles = open.map((id) => hiddenEntries.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  if (articles.length === 0) return <>{children}</>;
  const shown = articles.some((a) => a.id === active) ? active : null;

  const markDirty = (id: string) => (isDirty: boolean) =>
    setDirty((prev) => {
      if (prev.has(id) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(id);
      else next.delete(id);
      return next;
    });

  const requestClose = (id: string) => (dirty.has(id) ? setConfirmClose(id) : closeTab(host, id));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-editor">
      <div role="tablist" aria-label="Open articles" className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-divider px-2 pt-1.5" data-cv-article-tabs={host}>
        <button
          type="button"
          role="tab"
          aria-selected={shown === null}
          onClick={() => activate(host, null)}
          className={`${TAB} ${shown === null ? "border-divider bg-editor text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}
        >
          {homeLabel}
        </button>
        {articles.map((a) => {
          const kind = KIND_META[readKb(a.config)?.kind ?? "facts"] ?? KIND_META.facts;
          const selected = shown === a.id;
          return (
            <div
              key={a.id}
              role="tab"
              aria-selected={selected}
              title={a.name}
              className={`${TAB} ${selected ? "border-divider bg-editor text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}
              onAuxClick={(e) => e.button === 1 && requestClose(a.id)}
            >
              <button type="button" className="flex min-w-0 items-center gap-1.5" onClick={() => activate(host, a.id)}>
                <IconSlot icon={kind.icon} size={12} className="shrink-0" />
                <span className="truncate">{a.name}</span>
                {dirty.has(a.id) && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved changes" />}
              </button>
              <button
                type="button"
                aria-label={`Close ${a.name}`}
                onClick={() => requestClose(a.id)}
                className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-ink-faint opacity-60 hover:bg-hover hover:text-ink hover:opacity-100"
              >
                <IconSlot icon="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {/* Every view stays mounted, so switching tabs keeps scroll position and unsaved edits. */}
      <div className={shown === null ? "flex min-h-0 flex-1 flex-col" : "hidden"}>{children}</div>
      {articles.map((a) => (
        <div key={a.id} className={shown === a.id ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <DocumentView entryId={a.id} isActive={visible && shown === a.id} onDirtyChange={markDirty(a.id)} />
        </div>
      ))}
      {confirmClose && (
        <ConfirmDialog
          title="Unsaved Changes"
          message="This article has unsaved changes. Close it and discard them?"
          confirmLabel="Discard"
          variant="danger"
          onConfirm={() => {
            closeTab(host, confirmClose);
            markDirty(confirmClose)(false);
            setConfirmClose(null);
          }}
          onCancel={() => setConfirmClose(null)}
        />
      )}
    </div>
  );
}
