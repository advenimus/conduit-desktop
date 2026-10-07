/** Notes migration and the change log (docs/KNOWLEDGE_BASE.md 7, 8). */

import type { EntryMeta } from '../vault/vault.js';
import { isKbKind, readKb, type KbEditorRef, type KbKind } from './kb-model.js';
import { CHANGELOG_TITLE, formatChangelogLine, insertChangelogLine } from './changelog.js';
import { MIGRATION_POINTER, splitNotes } from './notes-split.js';
import { createArticle, KbError, updateArticle, type KbVault } from './kb-store.js';

export interface ImportedArticle {
  title: string;
  kind: KbKind;
  content: string;
  summary?: string;
  pinned?: boolean;
}

export function importNotes(
  vault: KbVault,
  entryId: string,
  articles: readonly ImportedArticle[],
  notesAfter: 'keep' | 'pointer',
  editor: KbEditorRef,
): EntryMeta[] {
  if (articles.length === 0) throw new KbError('articles must not be empty');
  // Checked before anything is written, so a bad article can't leave a half-finished import behind.
  for (const a of articles) {
    if (typeof a.title !== 'string' || !a.title.trim()) throw new KbError('Every article needs a title');
    if (!isKbKind(a.kind)) throw new KbError(`Unknown kind for "${a.title}"`);
  }
  const created = articles.map((a) =>
    createArticle(vault, { scope: 'asset', entry_id: entryId, title: a.title, kind: a.kind, content: a.content, summary: a.summary, pinned: a.pinned, reason: 'Moved from notes' }, editor),
  );
  if (notesAfter === 'pointer') vault.updateEntry(entryId, { notes: MIGRATION_POINTER });
  return created;
}

/** "Split by headings": the AI-free migration. */
export function splitNotesIntoArticles(vault: KbVault, entryId: string, notesAfter: 'keep' | 'pointer'): EntryMeta[] {
  const notes = vault.getEntryMeta(entryId).notes ?? '';
  const parts = splitNotes(notes);
  if (parts.length === 0) throw new KbError('These notes are empty');
  return importNotes(vault, entryId, parts.map((p) => ({ title: p.title, kind: p.kind, content: p.body, pinned: p.pinned })), notesAfter, { kind: 'user', device: 'desktop' });
}

export function dismissMigration(vault: KbVault, entryId: string): void {
  const entry = vault.getEntryMeta(entryId);
  vault.updateEntry(entryId, { config: { ...entry.config, kb_migration_dismissed: true } });
}

export function logChange(vault: KbVault, entryId: string, text: string, editor: KbEditorRef): EntryMeta {
  if (!text?.trim()) throw new KbError('text is required');
  const at = new Date().toISOString();
  const line = formatChangelogLine(at, editor.kind === 'agent' ? (editor.name ?? 'An AI agent') : null, text);
  const existing = vault.listEntries().find((e) => e.parent_entry_id === entryId && readKb(e.config)?.kind === 'changelog' && readKb(e.config)?.status !== 'archived');
  if (!existing) {
    return createArticle(vault, { scope: 'asset', entry_id: entryId, title: CHANGELOG_TITLE, kind: 'changelog', content: `# ${CHANGELOG_TITLE}\n\n${line}`, summary: 'What changed on this asset, newest first' }, editor);
  }
  const content = typeof existing.config.content === 'string' ? existing.config.content : '';
  return updateArticle(vault, existing.id, { content: insertChangelogLine(content, line), reason: 'Logged a change' }, editor);
}
