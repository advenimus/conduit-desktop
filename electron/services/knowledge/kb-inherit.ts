/** Which articles apply to an asset or folder, in display order (docs/KNOWLEDGE_BASE.md section 4). */

import { kindRank, readKb, type KbMeta } from './kb-model.js';

export interface KbEntryLike {
  id: string;
  name: string;
  entry_type: string;
  folder_id: string | null;
  parent_entry_id: string | null;
  tags: string[];
  config: unknown;
}

export interface KbFolderLike {
  id: string;
  parent_id: string | null;
}

export type KbGroup = 'asset' | 'folder' | 'vault';

export interface InheritedArticle<E extends KbEntryLike> {
  entry: E;
  kb: KbMeta;
  group: KbGroup;
  /** The folder a folder-group article belongs to. */
  folder_id: string | null;
}

export type KbTarget = { entry_id: string } | { folder_id: string };

interface Candidate<E> {
  entry: E;
  kb: KbMeta;
}

function compareArticles<E extends KbEntryLike>(a: Candidate<E>, b: Candidate<E>): number {
  if (!!a.kb.pinned !== !!b.kb.pinned) return a.kb.pinned ? -1 : 1;
  const kind = kindRank(a.kb.kind) - kindRank(b.kb.kind);
  if (kind !== 0) return kind;
  const an = a.entry.name.toLowerCase();
  const bn = b.entry.name.toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Folder of the entry, or of its nearest ancestor entry that has one. */
export function effectiveFolderId<E extends KbEntryLike>(entryId: string, byId: Map<string, E>): string | null {
  const seen = new Set<string>();
  let current = byId.get(entryId);
  while (current && !seen.has(current.id)) {
    if (current.folder_id) return current.folder_id;
    seen.add(current.id);
    current = current.parent_entry_id ? byId.get(current.parent_entry_id) : undefined;
  }
  return null;
}

export function folderChain(folderId: string | null, folders: readonly KbFolderLike[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: string[] = [];
  let current = folderId ? byId.get(folderId) : undefined;
  while (current && !chain.includes(current.id)) {
    chain.push(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return chain;
}

export function liveArticles<E extends KbEntryLike>(entries: readonly E[]): Candidate<E>[] {
  const out: Candidate<E>[] = [];
  for (const entry of entries) {
    if (entry.entry_type !== 'document') continue;
    const kb = readKb(entry.config);
    if (kb && kb.status !== 'archived') out.push({ entry, kb });
  }
  return out;
}

export function knowledgeFor<E extends KbEntryLike>(target: KbTarget, entries: readonly E[], folders: readonly KbFolderLike[]): InheritedArticle<E>[] {
  const articles = liveArticles(entries);
  const result: InheritedArticle<E>[] = [];
  const push = (group: KbGroup, list: Candidate<E>[], folderId: string | null = null) => {
    for (const c of [...list].sort(compareArticles)) result.push({ ...c, group, folder_id: folderId });
  };

  let startFolder: string | null;
  let tags: Set<string> = new Set();
  if ('entry_id' in target) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const asset = byId.get(target.entry_id);
    push('asset', articles.filter((a) => a.kb.scope === 'asset' && a.entry.parent_entry_id === target.entry_id));
    startFolder = effectiveFolderId(target.entry_id, byId);
    tags = new Set((asset?.tags ?? []).map((t) => t.toLowerCase()));
  } else {
    startFolder = target.folder_id;
  }

  for (const folderId of folderChain(startFolder, folders)) {
    push('folder', articles.filter((a) => a.kb.scope === 'folder' && a.entry.folder_id === folderId), folderId);
  }

  push('vault', articles.filter((a) => a.kb.scope === 'vault' && (a.kb.pinned || a.entry.tags.some((t) => tags.has(t.toLowerCase())))));
  return result;
}
