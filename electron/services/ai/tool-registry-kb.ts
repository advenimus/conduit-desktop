/** Registry entries for the knowledge base, secret and command tools (the MCP server holds the full schemas). */

import type { ToolRegistryEntry } from './tool-registry.js';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });

export const KB_AND_SECRET_TOOLS: ToolRegistryEntry[] = [
  {
    name: 'command_execute',
    category: 'execute',
    description: 'Run a saved command entry (its command, shell and run-as credential come from the vault) and return its output.',
    parameters: obj({ entry_id: s('Command entry id'), timeout_ms: { type: 'number' } }, ['entry_id']),
    ipcType: 'CommandExecute',
  },
  {
    name: 'kb_context',
    category: 'read',
    description: 'List the knowledge articles that apply to an asset (own, folders, vault playbooks) or a folder. Call before working.',
    parameters: obj({ entry_id: s('Asset entry id'), folder_id: s('Folder id') }),
    ipcType: 'KbContext',
  },
  {
    name: 'kb_search',
    category: 'read',
    description: 'Search every knowledge article by title, tags, summary and body.',
    parameters: obj({ query: s('Words to look for'), kind: s('Only this kind'), entry_id: s('Only what applies to this asset') }, ['query']),
    ipcType: 'KbSearch',
  },
  {
    name: 'kb_read',
    category: 'read',
    description: 'Read one knowledge article with its revision list.',
    parameters: obj({ article_id: s('Article id') }, ['article_id']),
    ipcType: 'KbRead',
  },
  {
    name: 'kb_write',
    category: 'write',
    description: 'Create or update a knowledge article. Saves at once; the user can review and undo. Use for findings, procedures, fixes and facts the user tells you, rather than your own memory.',
    parameters: obj({
      article_id: s('Article to update'),
      scope: s('asset, folder or vault (new articles)'),
      entry_id: s('Asset for a new asset article'),
      folder_id: s('Folder for a new folder article'),
      kind: s('overview, facts, procedure, troubleshooting, contact, playbook'),
      title: s('Title'),
      content: s('Markdown body'),
      summary: s('One-line summary'),
      reason: s('Why you changed it'),
    }),
    ipcType: 'KbWrite',
  },
  {
    name: 'kb_log',
    category: 'write',
    description: 'Add a dated line to the asset change log. Log every change you make on a system.',
    parameters: obj({ entry_id: s('Asset entry id'), text: s('What changed') }, ['entry_id', 'text']),
    ipcType: 'KbLog',
  },
  {
    name: 'kb_verify',
    category: 'write',
    description: 'Mark an article verified (still true) or needs review.',
    parameters: obj({ article_id: s('Article id'), still_true: { type: 'boolean' }, note: s('What you checked') }, ['article_id', 'still_true']),
    ipcType: 'KbVerify',
  },
  {
    name: 'kb_archive',
    category: 'write',
    description: 'Archive an article that no longer applies.',
    parameters: obj({ article_id: s('Article id') }, ['article_id']),
    ipcType: 'KbArchive',
  },
  {
    name: 'kb_import_notes',
    category: 'write',
    description: 'Move an asset\'s notes into knowledge articles, after the user agrees. Keep secret tokens and refs as they appear.',
    parameters: obj({ entry_id: s('Asset entry id'), articles: { type: 'array' }, notes_after: s('keep or pointer') }, ['entry_id', 'articles']),
    ipcType: 'KbImportNotes',
  },
  {
    name: 'kb_dismiss_migration',
    category: 'write',
    description: 'The user declined moving this asset\'s notes into articles; stop suggesting it.',
    parameters: obj({ entry_id: s('Asset entry id') }, ['entry_id']),
    ipcType: 'KbDismissMigration',
  },
  {
    name: 'secret_create',
    category: 'credential',
    description: 'Store a new encrypted secret on an entry and get a ref. Prefer generate so the value never passes through you.',
    parameters: obj({ owner_id: s('Entry the secret belongs to'), label: s('Chip label'), generate: { type: 'object' }, value: s('Value, if you already have it') }, ['owner_id', 'label']),
    ipcType: 'SecretCreate',
  },
  {
    name: 'secret_rotate',
    category: 'credential',
    description: 'Stage a new value for a secret; type {{secret:<id>.pending}} where the new password goes, then secret_commit.',
    parameters: obj({ secret: s('Secret id or ref'), generate: { type: 'object' }, value: s('New value, if you already have it') }, ['secret']),
    ipcType: 'SecretRotate',
  },
  {
    name: 'secret_commit',
    category: 'credential',
    description: 'Make the staged rotation value current; the old one goes to password history.',
    parameters: obj({ secret: s('Secret id or ref') }, ['secret']),
    ipcType: 'SecretCommit',
  },
  {
    name: 'secret_discard',
    category: 'credential',
    description: 'Drop a staged rotation value.',
    parameters: obj({ secret: s('Secret id or ref') }, ['secret']),
    ipcType: 'SecretDiscard',
  },
  {
    name: 'secret_capture',
    category: 'credential',
    description: 'Save a value shown in a terminal (pattern) or web page (selector) straight into a new secret, without seeing it.',
    parameters: obj({ connection_id: s('Session id'), owner_id: s('Owner entry'), label: s('Chip label'), pattern: s('Terminal regex'), selector: s('Web CSS selector') }, ['connection_id', 'owner_id', 'label']),
    ipcType: 'SecretCapture',
  },
  {
    name: 'secret_reveal',
    category: 'credential',
    description: 'Ask the user to show a secret\'s plain value (they approve in a dialog). Only when the value itself must be shown.',
    parameters: obj({ secret: s('Secret id or ref'), purpose: s('Why it is needed') }, ['secret', 'purpose']),
    ipcType: 'CredentialGet',
  },
];
