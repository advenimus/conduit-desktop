/** MCP requests for the knowledge base (docs/KNOWLEDGE_BASE.md). Agent writes save at once, marked for review. */

import type { AppState } from '../../services/state.js';
import { isKbKind, type KbEditorRef, type KbKind, type KbScope } from '../../services/knowledge/kb-model.js';
import { createArticle, KbError, updateArticle, verifyArticle, type ArticleChanges, type KbVault } from '../../services/knowledge/kb-store.js';
import { knowledgeContext, readArticle, searchKnowledge } from '../../services/knowledge/kb-query.js';
import { dismissMigration, importNotes, logChange, type ImportedArticle } from '../../services/knowledge/kb-notes.js';
import { agentDisplayName } from '../agent-names.js';
import { notifyRendererEntryChanged, resolveEntryId } from '../entry-helpers.js';
import { errorResponse, successResponse, type IpcResponse } from '../ipc-response.js';
import type { AgentIdentity } from '../session-claims.js';
import { lockedResponse, vaultFailure } from '../vault-guard.js';

export const KNOWLEDGE_REQUEST_TYPES = new Set([
  'KbContext', 'KbSearch', 'KbRead', 'KbWrite', 'KbLog', 'KbVerify', 'KbArchive', 'KbImportNotes', 'KbDismissMigration',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function written(entry: { id: string; name: string; updated_at: string }) {
  notifyRendererEntryChanged();
  return successResponse({ id: entry.id, title: entry.name, updated_at: entry.updated_at });
}

function changesFrom(p: Record<string, unknown>): ArticleChanges {
  return {
    title: str(p.title),
    kind: isKbKind(p.kind) ? p.kind : undefined,
    content: str(p.content),
    summary: str(p.summary),
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : undefined,
    pinned: typeof p.pinned === 'boolean' ? p.pinned : undefined,
    reason: str(p.reason),
  };
}

export async function handleKnowledgeRequest(
  request: { type: string; payload?: Record<string, unknown> },
  state: AppState,
  agent: AgentIdentity | null,
): Promise<IpcResponse> {
  const vault = state.getActiveVault();
  if (!vault.isUnlocked()) return lockedResponse(state, 'Vault is locked');
  const kv = vault as unknown as KbVault;
  const p = request.payload ?? {};
  const editor: KbEditorRef = { kind: 'agent', name: agentDisplayName(agent) };
  const entryId = () => {
    const id = str(p.entry_id);
    if (!id) throw new KbError('entry_id is required');
    return resolveEntryId(id, state);
  };

  try {
    switch (request.type) {
      case 'KbContext': {
        const folderId = str(p.folder_id);
        return successResponse({ articles: knowledgeContext(kv, folderId ? { folder_id: folderId } : { entry_id: entryId() }) });
      }
      case 'KbSearch': {
        const query = str(p.query)?.trim();
        if (!query) throw new KbError('query is required');
        const id = str(p.entry_id) ? entryId() : undefined;
        return successResponse({ results: searchKnowledge(kv, query, { kind: str(p.kind), entry_id: id }) });
      }
      case 'KbRead':
        return successResponse(readArticle(kv, str(p.article_id) ?? ''));
      case 'KbWrite': {
        const articleId = str(p.article_id);
        if (articleId) {
          const changes = changesFrom(p);
          if (str(p.status) === 'active') changes.status = 'active';
          return written(vault.runNonInteractive(() => updateArticle(kv, articleId, changes, editor)));
        }
        const scope = str(p.scope) as KbScope | undefined;
        if (!isKbKind(p.kind)) throw new KbError('kind is required to create an article');
        const created = vault.runNonInteractive(() => createArticle(kv, {
          scope: scope ?? 'asset',
          entry_id: scope === 'asset' || !scope ? entryId() : null,
          folder_id: str(p.folder_id) ?? null,
          title: str(p.title) ?? '',
          kind: p.kind as KbKind,
          content: str(p.content) ?? '',
          summary: str(p.summary),
          tags: changesFrom(p).tags,
          pinned: typeof p.pinned === 'boolean' ? p.pinned : undefined,
          reason: str(p.reason),
        }, editor));
        return written(created);
      }
      case 'KbLog':
        return written(vault.runNonInteractive(() => logChange(kv, entryId(), str(p.text) ?? '', editor)));
      case 'KbVerify':
        return written(vault.runNonInteractive(() => verifyArticle(kv, str(p.article_id) ?? '', p.still_true !== false, str(p.note), editor)));
      case 'KbArchive':
        return written(vault.runNonInteractive(() => updateArticle(kv, str(p.article_id) ?? '', { status: 'archived' }, editor)));
      case 'KbImportNotes': {
        const articles = Array.isArray(p.articles) ? (p.articles as ImportedArticle[]) : [];
        const after = p.notes_after === 'pointer' ? 'pointer' : 'keep';
        const id = entryId();
        const created = vault.runNonInteractive(() => importNotes(kv, id, articles, after, editor));
        notifyRendererEntryChanged();
        return successResponse({ created: created.map((e) => ({ id: e.id, title: e.name })), notes: after === 'pointer' ? 'replaced with a pointer' : 'kept' });
      }
      case 'KbDismissMigration': {
        const id = entryId();
        vault.runNonInteractive(() => dismissMigration(kv, id));
        notifyRendererEntryChanged();
        return successResponse({ id, dismissed: true });
      }
      default:
        return errorResponse('UNKNOWN_REQUEST', `Unknown knowledge request ${request.type}`);
    }
  } catch (e) {
    if (e instanceof KbError) return errorResponse('INVALID_ARGUMENT', e.message);
    return vaultFailure('KB_ERROR', e);
  }
}
