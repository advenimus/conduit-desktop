/**
 * Creating and changing knowledge articles (docs/KNOWLEDGE_BASE.md 1.1, 5). Every content save
 * encrypts !!value!! spans, appends a revision and records who edited, so agent edits can be
 * reviewed and undone.
 */

import type { EntryMeta } from '../vault/vault.js';
import { createPlannedSecrets, planFieldConversion, refreshOrphans, type SecretVault } from '../secrets/embedded-secrets.js';
import { isKbKind, KB_SUMMARY_MAX, readKb, type KbEditorRef, type KbKind, type KbMeta, type KbScope, type KbStatus } from './kb-model.js';
import { appendRevision, baselineRevision, readHistory, UNDO_REASON, type KbRevision } from './kb-revisions.js';

export type KbVault = SecretVault & Pick<import('../vault/vault.js').ConduitVault, 'listFolders'>;

export class KbError extends Error {}

export interface ArticlePlacement {
  scope: KbScope;
  entry_id?: string | null;
  folder_id?: string | null;
}

export interface NewArticle extends ArticlePlacement {
  title: string;
  kind: KbKind;
  content: string;
  summary?: string;
  tags?: string[];
  pinned?: boolean;
  reason?: string;
}

export interface ArticleChanges {
  title?: string;
  kind?: KbKind;
  content?: string;
  summary?: string;
  tags?: string[];
  pinned?: boolean;
  status?: KbStatus;
  reason?: string;
}

const nowIso = () => new Date().toISOString();

// Summaries and titles are stored as plain text, so a !!secret!! in them must never be kept.
// Refs are hidden too, so a summary derived before conversion matches one derived after it.
const hideSecretSpans = (text: string) => text.replace(/!!(.+?)!!|\{\{(?:secret|cred):[^}\n]*\}\}/g, '••••');

function cleanSummary(summary: string | undefined, content: string): string {
  // Derived summaries skip table rows and rules, which read badly on one line.
  const firstLine = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('|') && !/^[-*_=\s]+$/.test(l))
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  const source = summary?.trim() || firstLine || '';
  return Array.from(hideSecretSpans(source)).slice(0, KB_SUMMARY_MAX).join('');
}

function cleanTitle(title: string | undefined): string {
  const t = hideSecretSpans(title ?? '').trim();
  if (!t) throw new KbError('title is required');
  return t.slice(0, 200);
}

export function requireArticle(vault: KbVault, id: string): { entry: EntryMeta; kb: KbMeta } {
  let entry: EntryMeta;
  try {
    entry = vault.getEntryMeta(id);
  } catch {
    throw new KbError(`No knowledge article with id ${id}`);
  }
  const kb = entry.entry_type === 'document' ? readKb(entry.config) : null;
  if (!kb) throw new KbError(`${entry.name} is not a knowledge article`);
  return { entry, kb };
}

function placementFields(vault: KbVault, p: ArticlePlacement): { folder_id: string | null; parent_entry_id: string | null } {
  if (p.scope === 'asset') {
    if (!p.entry_id) throw new KbError('entry_id is required for an asset article');
    const owner = vault.getEntryMeta(p.entry_id);
    if (readKb(owner.config) || owner.config?.embedded) throw new KbError('Articles attach to assets, not to other articles or secrets');
    return { folder_id: null, parent_entry_id: owner.id };
  }
  if (p.scope === 'folder') {
    if (!p.folder_id || !vault.listFolders().some((f) => f.id === p.folder_id)) throw new KbError('folder_id must be an existing folder');
    return { folder_id: p.folder_id, parent_entry_id: null };
  }
  if (p.scope === 'vault') return { folder_id: null, parent_entry_id: null };
  throw new KbError('scope must be asset, folder or vault');
}

/** Encrypts secrets in `content`, then writes content, metadata and a new revision in one update. */
function saveContent(vault: KbVault, entry: EntryMeta, kb: KbMeta, content: string, editor: KbEditorRef, reason: string | undefined, extra: Partial<EntryMeta> = {}): EntryMeta {
  const { input, planned } = planFieldConversion({ config: { ...entry.config, content } });
  createPlannedSecrets(vault, entry.id, planned);
  const converted = input.config!.content as string;
  const at = nowIso();
  const history = appendRevision(readHistory(entry.config), { at, author: editor, ...(reason ? { reason } : {}), content: converted }, kb.reviewed_at);
  const nextKb: KbMeta = { ...kb, last_editor: { ...editor, at } };
  const saved = vault.updateEntry(entry.id, {
    ...extra,
    config: { ...entry.config, content: converted, kb: nextKb, kb_history: history },
  });
  refreshOrphans(vault, entry.id);
  return saved;
}

export function createArticle(vault: KbVault, input: NewArticle, editor: KbEditorRef): EntryMeta {
  if (!isKbKind(input.kind)) throw new KbError('kind must be overview, facts, procedure, troubleshooting, contact, playbook or changelog');
  const placement = placementFields(vault, input);
  const title = cleanTitle(input.title);
  const content = input.content ?? '';
  const siblings = input.scope === 'asset'
    ? vault.listEntries().filter((e) => e.parent_entry_id === placement.parent_entry_id && readKb(e.config)?.kind === 'overview' && readKb(e.config)?.pinned)
    : [];
  const kb: KbMeta = {
    v: 1,
    scope: input.scope,
    kind: input.kind,
    summary: cleanSummary(input.summary, content),
    pinned: input.pinned ?? (input.kind === 'overview' && siblings.length === 0),
    status: 'active',
    author: editor,
  };
  const created = vault.createEntry({ name: title, entry_type: 'document', ...placement, tags: input.tags ?? [], config: { content: '', kb } });
  return saveContent(vault, created, kb, content, editor, input.reason ?? 'Created');
}

export function updateArticle(vault: KbVault, id: string, changes: ArticleChanges, editor: KbEditorRef): EntryMeta {
  const { entry, kb } = requireArticle(vault, id);
  if (changes.kind !== undefined && !isKbKind(changes.kind)) throw new KbError('Unknown kind');
  const nextKb: KbMeta = {
    ...kb,
    ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
    ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}),
    ...(changes.status !== undefined ? { status: changes.status } : {}),
    ...(changes.summary !== undefined ? { summary: cleanSummary(changes.summary, '') } : {}),
  };
  const extra: Partial<EntryMeta> = {
    ...(changes.title !== undefined ? { name: cleanTitle(changes.title) } : {}),
    ...(changes.tags !== undefined ? { tags: changes.tags } : {}),
  };
  const current = typeof entry.config.content === 'string' ? entry.config.content : '';
  // A summary taken from the body's first line follows the body; one someone wrote stays.
  if (changes.summary === undefined && changes.content !== undefined && kb.summary === cleanSummary(undefined, current)) {
    nextKb.summary = cleanSummary(undefined, changes.content);
  }
  if (changes.content !== undefined && changes.content !== current) {
    return saveContent(vault, entry, nextKb, changes.content, editor, changes.reason, extra);
  }
  return vault.updateEntry(id, { ...extra, config: { ...entry.config, kb: nextKb } });
}

export function verifyArticle(vault: KbVault, id: string, stillTrue: boolean, note: string | undefined, editor: KbEditorRef): EntryMeta {
  const { entry, kb } = requireArticle(vault, id);
  const nextKb: KbMeta = stillTrue
    ? { ...kb, status: kb.status === 'needs_review' ? 'active' : kb.status, verified_at: nowIso(), verified_by: editor, ...(note ? { verify_note: note.slice(0, 500) } : {}) }
    : { ...kb, status: 'needs_review', ...(note ? { verify_note: note.slice(0, 500) } : {}) };
  return vault.updateEntry(id, { config: { ...entry.config, kb: nextKb } });
}

/** Review: mark every revision so far as seen. */
export function keepAgentEdits(vault: KbVault, id: string): EntryMeta {
  const { entry, kb } = requireArticle(vault, id);
  const history = readHistory(entry.config);
  const newest = history[history.length - 1]?.at ?? kb.last_editor?.at ?? nowIso();
  return vault.updateEntry(id, { config: { ...entry.config, kb: { ...kb, reviewed_at: newest } } });
}

/** Review: restore the baseline (5). Returns null when there is none, so the caller can offer Archive. */
export function undoAgentEdits(vault: KbVault, id: string): EntryMeta | null {
  const { entry, kb } = requireArticle(vault, id);
  const baseline = baselineRevision(readHistory(entry.config), kb.reviewed_at);
  if (!baseline) return null;
  return saveContent(vault, entry, kb, baseline.content, { kind: 'user', device: 'desktop' }, UNDO_REASON);
}

export function restoreRevision(vault: KbVault, id: string, at: string): EntryMeta {
  const { entry, kb } = requireArticle(vault, id);
  const rev: KbRevision | undefined = readHistory(entry.config).find((r) => r.at === at);
  if (!rev) throw new KbError('That revision is no longer in the history');
  return saveContent(vault, entry, kb, rev.content, { kind: 'user', device: 'desktop' }, `Restored the version from ${at.slice(0, 16).replace('T', ' ')} UTC`);
}
