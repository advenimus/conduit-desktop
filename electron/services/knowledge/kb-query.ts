/** Reading the knowledge base: inherited context, search and single articles (docs/KNOWLEDGE_BASE.md 4, 6, 7). */

import type { EntryMeta, FolderData } from '../vault/vault.js';
import { isStale, readKb, type KbMeta } from './kb-model.js';
import { knowledgeFor, type KbGroup, type KbTarget } from './kb-inherit.js';
import { hasUnseenAgentEdit, readHistory } from './kb-revisions.js';
import { migrationSuggestion, type MigrationReason } from './notes-split.js';
import { requireArticle, type KbVault } from './kb-store.js';

export interface ArticleSummary {
  id: string;
  title: string;
  kind: string;
  scope: string;
  summary: string;
  group?: KbGroup;
  folder?: string | null;
  owner_id: string | null;
  tags: string[];
  status: string;
  pinned: boolean;
  updated_at: string;
  verified_at: string | null;
  stale: boolean;
  last_editor: string | null;
  unseen_agent_edit: boolean;
}

function editorName(kb: KbMeta): string | null {
  const e = kb.last_editor;
  if (!e) return null;
  return e.kind === 'agent' ? (e.name ?? 'An AI agent') : 'You';
}

export function summarize(entry: EntryMeta, kb: KbMeta, now: string, folderNames?: Map<string, string>): ArticleSummary {
  return {
    id: entry.id,
    title: entry.name,
    kind: kb.kind,
    scope: kb.scope,
    summary: kb.summary ?? '',
    owner_id: entry.parent_entry_id ?? entry.folder_id ?? null,
    folder: entry.folder_id ? (folderNames?.get(entry.folder_id) ?? null) : null,
    tags: entry.tags,
    status: kb.status,
    pinned: kb.pinned === true,
    updated_at: entry.updated_at,
    verified_at: kb.verified_at ?? null,
    stale: isStale(kb, entry.updated_at, now),
    last_editor: editorName(kb),
    unseen_agent_edit: hasUnseenAgentEdit(kb),
  };
}

const folderNameMap = (folders: readonly FolderData[]) => new Map(folders.map((f) => [f.id, f.name]));

export function knowledgeContext(vault: KbVault, target: KbTarget): ArticleSummary[] {
  const now = new Date().toISOString();
  const folders = vault.listFolders();
  const names = folderNameMap(folders);
  return knowledgeFor(target, vault.listEntries(), folders).map(({ entry, kb, group }) => ({ ...summarize(entry, kb, now, names), group }));
}

/** Every article, including archived ones, for the vault Knowledge view. */
export function allArticles(vault: KbVault): ArticleSummary[] {
  const now = new Date().toISOString();
  const names = folderNameMap(vault.listFolders());
  const out: ArticleSummary[] = [];
  for (const e of vault.listEntries()) {
    const kb = e.entry_type === 'document' ? readKb(e.config) : null;
    if (kb) out.push(summarize(e, kb, now, names));
  }
  return out;
}

export interface SearchHit extends ArticleSummary {
  score: number;
  snippet: string;
}

const MAX_HITS = 25;

function snippetAround(content: string, term: string): string {
  const i = content.toLowerCase().indexOf(term);
  if (i === -1) return content.slice(0, 160);
  const start = Math.max(0, i - 60);
  return `${start > 0 ? '…' : ''}${content.slice(start, i + 100).replace(/\s+/g, ' ')}…`;
}

export function searchKnowledge(vault: KbVault, query: string, opts: { kind?: string; entry_id?: string; include_archived?: boolean } = {}): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scopeIds = opts.entry_id ? new Set(knowledgeContext(vault, { entry_id: opts.entry_id }).map((a) => a.id)) : null;
  const now = new Date().toISOString();
  const names = folderNameMap(vault.listFolders());
  const hits: SearchHit[] = [];
  for (const e of vault.listEntries()) {
    const kb = e.entry_type === 'document' ? readKb(e.config) : null;
    if (!kb || (kb.status === 'archived' && !opts.include_archived)) continue;
    if (opts.kind && kb.kind !== opts.kind) continue;
    if (scopeIds && !scopeIds.has(e.id)) continue;
    const title = e.name.toLowerCase();
    const summary = (kb.summary ?? '').toLowerCase();
    const content = typeof e.config.content === 'string' ? e.config.content : '';
    const lower = content.toLowerCase();
    const tags = e.tags.map((t) => t.toLowerCase());
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 5;
      if (tags.includes(t)) score += 3;
      if (summary.includes(t)) score += 2;
      if (lower.includes(t)) score += 1;
    }
    if (score === 0) continue;
    hits.push({ ...summarize(e, kb, now, names), score, snippet: snippetAround(content, terms[0]) });
  }
  return hits.sort((a, b) => b.score - a.score || (a.updated_at < b.updated_at ? 1 : -1)).slice(0, MAX_HITS);
}

export interface ArticleDetail extends ArticleSummary {
  content: string;
  author: string | null;
  verify_note: string | null;
  history: Array<{ at: string; editor: string; reason: string | null }>;
}

export function readArticle(vault: KbVault, id: string): ArticleDetail {
  const { entry, kb } = requireArticle(vault, id);
  const now = new Date().toISOString();
  return {
    ...summarize(entry, kb, now, folderNameMap(vault.listFolders())),
    content: typeof entry.config.content === 'string' ? entry.config.content : '',
    author: kb.author?.kind === 'agent' ? (kb.author.name ?? 'An AI agent') : 'You',
    verify_note: kb.verify_note ?? null,
    history: readHistory(entry.config).map((r) => ({
      at: r.at,
      editor: r.author.kind === 'agent' ? (r.author.name ?? 'An AI agent') : 'You',
      reason: r.reason ?? null,
    })),
  };
}

export interface KnowledgeBlock {
  articles: Array<Pick<ArticleSummary, 'id' | 'title' | 'kind' | 'summary' | 'group' | 'stale'>>;
  stale_count: number;
  migration_suggested: MigrationReason | null;
  hint: string;
}

/** What entry_info adds so an agent always sees the knowledge an asset has, and when to offer migration. */
export function knowledgeBlock(vault: KbVault, entry: EntryMeta): KnowledgeBlock {
  const context = knowledgeContext(vault, { entry_id: entry.id });
  const own = context.filter((a) => a.group === 'asset').length;
  const migration = migrationSuggestion(entry.notes, own, entry.config?.kb_migration_dismissed === true);
  const hint = migration
    ? 'These notes look like a knowledge base. Offer the user once to move them into articles with kb_import_notes; if they decline, call kb_dismiss_migration.'
    : context.length
      ? 'Read the articles that matter with kb_read before working, and record what you learn with kb_write or kb_log.'
      : 'No knowledge yet. Record what you learn with kb_write (an overview first) or kb_log.';
  return {
    articles: context.map(({ id, title, kind, summary, group, stale }) => ({ id, title, kind, summary, group, stale })),
    stale_count: context.filter((a) => a.stale).length,
    migration_suggested: migration,
    hint,
  };
}
