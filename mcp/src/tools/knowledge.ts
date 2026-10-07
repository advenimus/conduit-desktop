/**
 * Knowledge base tools: a structured, shared memory for each asset, folder and the whole vault.
 * Agents read it before working and write what they learn as they go. Writes save at once; the user
 * reviews agent edits in Conduit and can undo them.
 */

import type { ConduitClient } from '../ipc-client.js';
import { maskSecrets, redactSecrets, restoreSecrets } from '../mask-secrets.js';
import { applyTextEdits, MAX_TEXT_EDITS, parseTextEdits } from '../text-edits.js';

const KINDS = ['overview', 'facts', 'procedure', 'troubleshooting', 'contact', 'playbook', 'changelog'];
const KIND_HELP =
  'overview: what this is and what matters most (one per asset, pinned); facts: configuration, versions, IPs, roles; ' +
  'procedure: steps that work; troubleshooting: a problem, its cause and the fix; contact: people and vendors; ' +
  'playbook: a vault-wide routine that applies to many assets (use tags to say which).';
const SECRETS_HELP =
  'Never write a plain password: keep {{secret:<id>|Label}} refs as they are, or create one with secret_create. ' +
  'Any !!value!! you write is encrypted into a ref on save.';

const textOf = (v: unknown) => (typeof v === 'string' ? v : '');

// ---------- kb_context ----------

export function kbContextDefinition() {
  return {
    name: 'kb_context',
    description:
      'List the knowledge articles that apply to an asset (its own, then its folders\' from nearest up, then vault playbooks ' +
      'that share a tag or are pinned) or to a folder. Call this before working on an asset. Returns summaries; read the ' +
      'ones that matter with kb_read. stale means not verified in 90 days; check it before relying on it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'Asset entry id (or the id of its open session)' },
        folder_id: { type: 'string', description: 'Folder id, instead of entry_id' },
      },
    },
  };
}

export async function kbContext(client: ConduitClient, args: { entry_id?: string; folder_id?: string }): Promise<unknown> {
  if (!args.entry_id && !args.folder_id) throw new Error('Give entry_id or folder_id.');
  return client.kbRequest('KbContext', args);
}

// ---------- kb_search ----------

export function kbSearchDefinition() {
  return {
    name: 'kb_search',
    description:
      'Search every knowledge article in the vault by words in the title, tags, summary and body. Use it to find how a ' +
      'problem was solved on other assets. Pass entry_id to search only what applies to one asset.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Words to look for' },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind' },
        entry_id: { type: 'string', description: 'Only articles that apply to this asset' },
      },
      required: ['query'],
    },
  };
}

export async function kbSearch(client: ConduitClient, args: { query: string; kind?: string; entry_id?: string }): Promise<unknown> {
  const result = await client.kbRequest('KbSearch', args);
  const results = Array.isArray(result.results) ? result.results : [];
  return { results: results.map((r: Record<string, unknown>) => ({ ...r, snippet: maskSecrets(textOf(r.snippet)) })) };
}

// ---------- kb_read ----------

export function kbReadDefinition() {
  return {
    name: 'kb_read',
    description: 'Read one knowledge article: its body, metadata and revision list. Secrets show as refs you can type with.',
    inputSchema: {
      type: 'object' as const,
      properties: { article_id: { type: 'string', description: 'Article id from kb_context or kb_search' } },
      required: ['article_id'],
    },
  };
}

export async function kbRead(client: ConduitClient, args: { article_id: string }): Promise<unknown> {
  const article = await client.kbRequest('KbRead', args);
  return { ...article, content: maskSecrets(textOf(article.content)) };
}

// ---------- kb_write ----------

export function kbWriteDefinition() {
  return {
    name: 'kb_write',
    description:
      'Create or update a knowledge article. It saves right away (no need to ask first) and the user can review and undo ' +
      'your edit in Conduit, so write whenever you learn something a future session would need: what you found, what you ' +
      'changed, what fixed a problem, and facts the user tells you about their systems. Use this rather than your own memory ' +
      'or files: it is shared with the user\'s other devices and agents. Keep one topic per article and update an existing one rather than adding a near duplicate. ' +
      'To create: give scope (asset, folder or vault), entry_id or folder_id, kind, title and content. ' +
      'To update: give article_id plus content (a full rewrite) or edits (exact find-and-replace, like entry_edit_notes), ' +
      'and a short reason. ' + KIND_HELP + ' ' + SECRETS_HELP,
    inputSchema: {
      type: 'object' as const,
      properties: {
        article_id: { type: 'string', description: 'Article to update; leave out to create one' },
        scope: { type: 'string', enum: ['asset', 'folder', 'vault'], description: 'Where a new article lives (default asset)' },
        entry_id: { type: 'string', description: 'Asset for a new asset article' },
        folder_id: { type: 'string', description: 'Folder for a new folder article; every asset in it inherits the article' },
        kind: { type: 'string', enum: KINDS, description: 'Article kind' },
        title: { type: 'string', description: 'Short title' },
        summary: { type: 'string', description: 'One line (max 200 characters) shown in lists and to other agents' },
        content: { type: 'string', description: 'Markdown body (replaces the body when updating)' },
        edits: {
          type: 'array',
          maxItems: MAX_TEXT_EDITS,
          description: 'Instead of content: changes to make, applied in order, all or nothing',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags; a vault playbook applies to assets that share one' },
        pinned: { type: 'boolean', description: 'Pin to the top' },
        reason: { type: 'string', description: 'Why you made this change (shown in the article history)' },
      },
    },
  };
}

export async function kbWrite(client: ConduitClient, args: Record<string, unknown>): Promise<unknown> {
  const { edits: rawEdits, ...rest } = args;
  if (typeof rest.article_id === 'string' && (rawEdits !== undefined || typeof rest.content === 'string')) {
    const current = await client.kbRequest('KbRead', { article_id: rest.article_id });
    const redacted = redactSecrets(textOf(current.content));
    let next: string;
    let replacements: number | undefined;
    if (rawEdits !== undefined) {
      const edited = applyTextEdits(redacted.text, parseTextEdits(rawEdits));
      next = edited.text;
      replacements = edited.replacements;
    } else {
      next = rest.content as string;
    }
    const restored = restoreSecrets(next, redacted);
    const result = await client.kbRequest('KbWrite', { ...rest, content: restored.text });
    return { ...result, ...(replacements !== undefined ? { replacements } : {}), secrets_removed: restored.secretsRemoved };
  }
  if (rawEdits !== undefined) throw new Error('edits need an article_id');
  return client.kbRequest('KbWrite', rest);
}

// ---------- kb_log ----------

export function kbLogDefinition() {
  return {
    name: 'kb_log',
    description:
      'Add one dated line to the asset\'s change log (created on first use), newest first. Log every change you make on a ' +
      'system: installs, config edits, restarts, password rotations. One short sentence per change.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'Asset entry id (or the id of its open session)' },
        text: { type: 'string', description: 'What changed, in one sentence' },
      },
      required: ['entry_id', 'text'],
    },
  };
}

export async function kbLog(client: ConduitClient, args: { entry_id: string; text: string }): Promise<unknown> {
  return client.kbRequest('KbLog', args);
}

// ---------- kb_verify ----------

export function kbVerifyDefinition() {
  return {
    name: 'kb_verify',
    description:
      'Record that you checked an article against the real system. still_true: true stamps it verified; false marks it ' +
      'needs review (then fix it with kb_write if you know the right content). Verify stale articles you relied on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        article_id: { type: 'string' },
        still_true: { type: 'boolean' },
        note: { type: 'string', description: 'What you checked or what is wrong' },
      },
      required: ['article_id', 'still_true'],
    },
  };
}

export async function kbVerify(client: ConduitClient, args: { article_id: string; still_true: boolean; note?: string }): Promise<unknown> {
  return client.kbRequest('KbVerify', args);
}

// ---------- kb_archive ----------

export function kbArchiveDefinition() {
  return {
    name: 'kb_archive',
    description: 'Archive an article that no longer applies (the asset was rebuilt, the issue is gone). Only the user can delete articles.',
    inputSchema: { type: 'object' as const, properties: { article_id: { type: 'string' } }, required: ['article_id'] },
  };
}

export async function kbArchive(client: ConduitClient, args: { article_id: string }): Promise<unknown> {
  return client.kbRequest('KbArchive', args);
}

// ---------- kb_import_notes ----------

export function kbImportNotesDefinition() {
  return {
    name: 'kb_import_notes',
    description:
      'Move an asset\'s notes into knowledge articles. Only after the user agrees (entry_info suggests it when notes look like ' +
      'a knowledge base). Read the notes with entry_info include_notes, split them into articles by topic, and keep any ' +
      '[SECRET_n] tokens or {{secret:...}} refs exactly as they appear so the secrets carry over. notes_after: keep leaves ' +
      'the notes as they are (default); pointer replaces them with a short line pointing to the Knowledge tab. ' + KIND_HELP,
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string' },
        articles: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              kind: { type: 'string', enum: KINDS },
              content: { type: 'string' },
              summary: { type: 'string' },
              pinned: { type: 'boolean' },
            },
            required: ['title', 'kind', 'content'],
          },
        },
        notes_after: { type: 'string', enum: ['keep', 'pointer'] },
      },
      required: ['entry_id', 'articles'],
    },
  };
}

export async function kbImportNotes(
  client: ConduitClient,
  args: { entry_id: string; articles: Array<Record<string, unknown>>; notes_after?: string },
): Promise<unknown> {
  if (!Array.isArray(args.articles) || args.articles.length === 0) throw new Error('articles must be a non-empty list');
  const entry = await client.entryGetInfo(args.entry_id, true);
  const redacted = redactSecrets(textOf(entry.notes));
  const articles = args.articles.map((a) => ({ ...a, content: restoreSecrets(textOf(a.content), redacted).text }));
  return client.kbRequest('KbImportNotes', { ...args, articles });
}

// ---------- kb_dismiss_migration ----------

export function kbDismissMigrationDefinition() {
  return {
    name: 'kb_dismiss_migration',
    description: 'The user does not want this asset\'s notes moved into articles. Stops entry_info from suggesting it again.',
    inputSchema: { type: 'object' as const, properties: { entry_id: { type: 'string' } }, required: ['entry_id'] },
  };
}

export async function kbDismissMigration(client: ConduitClient, args: { entry_id: string }): Promise<unknown> {
  return client.kbRequest('KbDismissMigration', args);
}
