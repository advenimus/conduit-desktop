import { useRef, useState } from "react";
import type { KbKind } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import MarkdownRenderer from "../markdown/MarkdownRenderer";
import { Button, IconSlot, Menu, MenuItem, Popover } from "../ui";
import ArticleRow from "./ArticleRow";
import NewArticleDialog from "./NewArticleDialog";
import { contentOf, KIND_META, NEW_ARTICLE_KINDS, openArticle } from "./kbUi";
import { useKnowledge } from "./useKnowledge";
import { entryInfoSessionId, folderViewSessionId } from "../../lib/dashboardSessions";

type PanelTarget = { entryId: string } | { folderId: string };

const OVERVIEW_PREVIEW_CHARS = 1200;

/** The Knowledge list on an asset or folder page: own articles by kind, then inherited ones. */
export default function KnowledgePanel({ target }: { target: PanelTarget }) {
  const kbTarget = "entryId" in target ? { entry_id: target.entryId } : { folder_id: target.folderId };
  const host = "entryId" in target ? entryInfoSessionId(target.entryId) : folderViewSessionId(target.folderId);
  const items = useKnowledge(kbTarget);
  const folders = useEntryStore((s) => s.folders);
  const ownGroup = "entryId" in target ? "asset" : "folder";
  const ownFolderId = "folderId" in target ? target.folderId : null;
  const own = items.filter((i) => i.group === ownGroup && (ownGroup === "asset" || i.folder_id === ownFolderId));
  const inherited = items.filter((i) => !own.includes(i));
  const overview = own.find((i) => i.kb.kind === "overview" && i.kb.pinned);
  const rest = own.filter((i) => i !== overview);
  const byKind = NEW_ARTICLE_KINDS.concat("changelog" as KbKind).map((k) => ({ kind: k, list: rest.filter((i) => i.kb.kind === k) })).filter((g) => g.list.length);

  const [menuOpen, setMenuOpen] = useState(false);
  const [newKind, setNewKind] = useState<KbKind | null>(null);
  const [showInherited, setShowInherited] = useState(true);
  const addRef = useRef<HTMLSpanElement>(null);
  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name ?? "folder";

  return (
    <div data-cv-knowledge-panel="">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-label text-ink-faint">
          {own.length === 0 ? "No articles yet" : `${own.length} ${own.length === 1 ? "article" : "articles"}`}
        </span>
        <span ref={addRef}>
          <Button size="sm" icon="plus" onClick={() => setMenuOpen((o) => !o)}>
            Article
          </Button>
        </span>
        <Popover anchorRef={addRef} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom-end" padding={false}>
          <Menu onClose={() => setMenuOpen(false)}>
            {NEW_ARTICLE_KINDS.filter((k) => k !== "playbook").map((k) => (
              <MenuItem key={k} icon={KIND_META[k].icon} onSelect={() => setNewKind(k)}>
                {KIND_META[k].label}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </div>

      {overview && (
        <div className="mb-3 rounded border border-card-border bg-well px-3 py-2">
          <button type="button" className="mb-1 flex items-center gap-1.5 text-label text-ink-muted hover:text-ink" onClick={() => openArticle(overview.entry.id, host)}>
            <IconSlot icon="pinFilled" size={12} />
            {overview.entry.name}
          </button>
          <MarkdownRenderer content={contentOf(overview.entry).slice(0, OVERVIEW_PREVIEW_CHARS)} />
        </div>
      )}

      {byKind.map(({ kind, list }) => (
        <section key={kind} className="mb-2">
          <h4 className="px-2 text-meta font-semibold uppercase tracking-wide text-ink-faint">{KIND_META[kind].plural}</h4>
          {list.map((i) => (
            <ArticleRow key={i.entry.id} entry={i.entry} kb={i.kb} host={host} />
          ))}
        </section>
      ))}

      {own.length === 0 && !overview && (
        <p className="px-2 py-3 text-body text-ink-muted">
          Agents add what they learn here as they work. You can also start with an overview.
        </p>
      )}

      {inherited.length > 0 && (
        <section className="mt-3 border-t border-divider pt-2">
          <button type="button" className="flex w-full items-center gap-1 px-2 text-meta font-semibold uppercase tracking-wide text-ink-faint" onClick={() => setShowInherited((v) => !v)}>
            <IconSlot icon={showInherited ? "chevronDown" : "chevronRight"} size={12} />
            Also applies ({inherited.length})
          </button>
          {showInherited &&
            inherited.map((i) => (
              <ArticleRow key={i.entry.id} entry={i.entry} kb={i.kb} host={host} context={i.group === "folder" ? folderName(i.folder_id) : "Vault"} />
            ))}
        </section>
      )}

      {newKind && (
        <NewArticleDialog
          scope={"entryId" in target ? "asset" : "folder"}
          entryId={"entryId" in target ? target.entryId : undefined}
          folderId={"folderId" in target ? target.folderId : undefined}
          initialKind={newKind}
          host={host}
          onClose={() => setNewKind(null)}
        />
      )}
    </div>
  );
}
