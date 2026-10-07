import { useMemo, useState } from "react";
import { hasUnseenAgentEdit, isStale, readKb, type KbKind } from "../../lib/kb";
import { useEntryStore } from "../../stores/entryStore";
import { Button, SearchInput, Select } from "../ui";
import ArticleRow from "./ArticleRow";
import NewArticleDialog from "./NewArticleDialog";
import { contentOf, KIND_META, type ArticleItem } from "./kbUi";

type ScopeFilter = "all" | "asset" | "folder" | "vault";
type StateFilter = "all" | "review" | "stale" | "archived";
type AuthorFilter = "all" | "agent" | "user";

const CONTENT_WIDTH = "mx-auto w-full max-w-4xl";

/** Every article in the vault: search, filters, and the queue of agent edits to review. */
export default function VaultKnowledgeView() {
  const entries = useEntryStore((s) => s.entries);
  const hiddenEntries = useEntryStore((s) => s.hiddenEntries);
  const folders = useEntryStore((s) => s.folders);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KbKind | "all">("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [author, setAuthor] = useState<AuthorFilter>("all");
  const [state, setState] = useState<StateFilter>("all");
  const [creating, setCreating] = useState(false);

  const articles: ArticleItem[] = useMemo(
    () => hiddenEntries.flatMap((entry) => {
      const kb = entry.entry_type === "document" ? readKb(entry.config) : null;
      return kb ? [{ entry, kb }] : [];
    }),
    [hiddenEntries],
  );
  const now = new Date().toISOString();
  const needsReview = articles.filter((a) => a.kb.status !== "archived" && a.kb.kind !== "changelog" && (hasUnseenAgentEdit(a.kb) || a.kb.status === "needs_review"));

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const listed = articles
    .filter((a) => (state === "archived" ? a.kb.status === "archived" : a.kb.status !== "archived"))
    .filter((a) => state !== "review" || needsReview.includes(a))
    .filter((a) => state !== "stale" || isStale(a.kb, a.entry.updated_at, now))
    .filter((a) => kind === "all" || a.kb.kind === kind)
    .filter((a) => scope === "all" || a.kb.scope === scope)
    .filter((a) => author === "all" || (a.kb.last_editor ?? a.kb.author).kind === author)
    .filter((a) => {
      if (terms.length === 0) return true;
      const hay = `${a.entry.name}\n${a.kb.summary}\n${a.entry.tags.join(" ")}\n${contentOf(a.entry)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (a.entry.updated_at < b.entry.updated_at ? 1 : -1));

  const contextOf = (a: ArticleItem) =>
    a.kb.scope === "asset"
      ? (entries.find((e) => e.id === a.entry.parent_entry_id)?.name ?? "Asset")
      : a.kb.scope === "folder"
        ? (folders.find((f) => f.id === a.entry.folder_id)?.name ?? "Folder")
        : "Vault";

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-editor" data-cv-knowledge-view="">
      <div className="border-b border-divider py-6">
        <div className={`${CONTENT_WIDTH} flex items-center gap-3 px-6`}>
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-semibold text-ink">Knowledge</h2>
            <p className="text-body text-ink-muted">
              {articles.length} {articles.length === 1 ? "article" : "articles"} that agents and you keep about this vault
            </p>
          </div>
          <Button icon="plus" onClick={() => setCreating(true)}>
            Vault playbook
          </Button>
        </div>
      </div>

      <div className={`${CONTENT_WIDTH} px-6 py-4`}>
        {needsReview.length > 0 && state === "all" && (
          <section className="mb-5 rounded border border-card-border bg-card p-3">
            <h3 className="mb-1 text-body font-semibold text-ink">Needs review ({needsReview.length})</h3>
            <p className="mb-2 text-label text-ink-muted">Agent edits you have not looked at, and articles flagged as out of date.</p>
            {needsReview.slice(0, 8).map((a) => (
              <ArticleRow key={a.entry.id} entry={a.entry} kb={a.kb} context={contextOf(a)} />
            ))}
            {needsReview.length > 8 && (
              <Button variant="link" onClick={() => setState("review")}>
                Show all {needsReview.length}
              </Button>
            )}
          </section>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Search knowledge..." aria-label="Search knowledge" wrapperClassName="max-w-xs flex-1" />
          <span className="w-40 shrink-0">
            <Select value={kind} onChange={(e) => setKind(e.target.value as KbKind | "all")} aria-label="Kind">
              <option value="all">All kinds</option>
              {(Object.keys(KIND_META) as KbKind[]).map((k) => (
                <option key={k} value={k}>{KIND_META[k].label}</option>
              ))}
            </Select>
          </span>
          <span className="w-36 shrink-0">
            <Select value={scope} onChange={(e) => setScope(e.target.value as ScopeFilter)} aria-label="Where">
              <option value="all">Everywhere</option>
              <option value="asset">Assets</option>
              <option value="folder">Folders</option>
              <option value="vault">Vault</option>
            </Select>
          </span>
          <span className="w-36 shrink-0">
            <Select value={author} onChange={(e) => setAuthor(e.target.value as AuthorFilter)} aria-label="Edited by">
              <option value="all">Anyone</option>
              <option value="agent">Agents</option>
              <option value="user">You</option>
            </Select>
          </span>
          <span className="w-48 shrink-0">
            <Select value={state} onChange={(e) => setState(e.target.value as StateFilter)} aria-label="State">
              <option value="all">Active</option>
              <option value="review">Needs review</option>
              <option value="stale">Not checked in 90 days</option>
              <option value="archived">Archived</option>
            </Select>
          </span>
        </div>

        {listed.length === 0 ? (
          <p className="py-8 text-center text-body text-ink-muted">
            {articles.length === 0 ? "No knowledge yet. Agents add articles as they work on your assets." : "No articles match."}
          </p>
        ) : (
          listed.map((a) => <ArticleRow key={a.entry.id} entry={a.entry} kb={a.kb} context={contextOf(a)} />)
        )}
      </div>

      {creating && <NewArticleDialog scope="vault" initialKind="playbook" onClose={() => setCreating(false)} />}
    </div>
  );
}
