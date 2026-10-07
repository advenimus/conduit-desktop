/**
 * Entry & document MCP tools.
 *
 * Read tools show legacy !!secret!! values as [SECRET_n] tokens; encrypted secrets are refs.
 * Write tools (update/edit notes, create/update documents) put tokens back as the stored
 * secrets, and the app encrypts any !!value!! into a secret ref on save.
 */

import type { ConduitClient } from '../ipc-client.js';
import { maskSecrets, redactSecrets, restoreSecrets } from '../mask-secrets.js';
import { applyTextEdits, MAX_TEXT_EDITS, parseTextEdits } from '../text-edits.js';

const SECRET_TOKENS_HELP =
  'Encrypted secrets show as {{secret:<id>|Label}} refs: keep or copy a ref as is, and put it in a typing tool to use the secret. ' +
  'Older unencrypted secrets show as [SECRET_n] tokens: keep a token where it is to keep that secret. ' +
  'To add a secret, write !!value!! (Conduit encrypts it on save and stores a ref; secrets_encrypted counts them), ' +
  'or better, create one with secret_create so you never handle the value.';

function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------- entry_info ----------

export function entryInfoDefinition() {
  return {
    name: 'entry_info',
    description:
      'Get metadata for any vault entry (connection, document, command). ' +
      'Optionally include notes, with !!secret!! values shown as [SECRET_n] tokens. ' +
      'has_conflict is true when devices saved different values and the conflict is not resolved yet; ' +
      'the values shown are the provisional ones.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry' },
        include_notes: {
          type: 'boolean',
          description: 'Include the entry notes field (secrets shown as [SECRET_n] tokens). Default: false',
        },
      },
      required: ['entry_id'],
    },
  };
}

export async function entryInfo(
  client: ConduitClient,
  args: { entry_id: string; include_notes?: boolean },
): Promise<unknown> {
  const entry = await client.entryGetInfo(args.entry_id, args.include_notes);

  const result: Record<string, unknown> = {
    id: entry.id,
    name: entry.name,
    entry_type: entry.entry_type,
    host: entry.host ?? null,
    port: entry.port ?? null,
    tags: entry.tags ?? [],
    folder_id: entry.folder_id ?? null,
    parent_entry_id: entry.parent_entry_id ?? null,
    is_favorite: entry.is_favorite ?? false,
    credential_id: entry.credential_id ?? null,
    username: entry.username ?? null,
    domain: entry.domain ?? null,
    created_at: entry.created_at ?? '',
    updated_at: entry.updated_at ?? '',
    has_conflict: entry.has_conflict === true,
  };

  if (args.include_notes) {
    const notes = entry.notes as string | null;
    result.notes = notes ? maskSecrets(notes) : null;
  }

  return result;
}

// ---------- document_read ----------

export function documentReadDefinition() {
  return {
    name: 'document_read',
    description:
      'Read the markdown content of a document entry. !!secret!! values show as [SECRET_n] tokens.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the document entry' },
      },
      required: ['entry_id'],
    },
  };
}

export async function documentRead(
  client: ConduitClient,
  args: { entry_id: string },
): Promise<unknown> {
  const doc = await client.entryGetDocument(args.entry_id);

  const content = doc.content as string | null;

  return {
    id: doc.id,
    name: doc.name,
    content: content ? maskSecrets(content) : null,
    tags: doc.tags ?? [],
    created_at: doc.created_at ?? '',
    updated_at: doc.updated_at ?? '',
  };
}

// ---------- entry_update_notes ----------

export function entryUpdateNotesDefinition() {
  return {
    name: 'entry_update_notes',
    description:
      'Replace all of the markdown notes on any vault entry. To change only part of the notes, use entry_edit_notes instead. ' +
      SECRET_TOKENS_HELP + ' ' +
      'IMPORTANT: Always show the user what you plan to write and get their approval before calling this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry to update' },
        notes: { type: 'string', description: 'New markdown notes content (replaces existing notes)' },
      },
      required: ['entry_id', 'notes'],
    },
  };
}

export async function entryUpdateNotes(
  client: ConduitClient,
  args: { entry_id: string; notes: string },
): Promise<unknown> {
  if (typeof args.notes !== 'string') throw new Error('notes must be a string.');
  const current = await client.entryGetInfo(args.entry_id, true);
  const restored = restoreSecrets(args.notes, redactSecrets(textField(current.notes)));
  const result = await client.entryUpdateNotes(args.entry_id, restored.text);
  return { ...result, secrets_removed: restored.secretsRemoved };
}

// ---------- entry_edit_notes ----------

export function entryEditNotesDefinition() {
  return {
    name: 'entry_edit_notes',
    description:
      'Change part of the markdown notes on any vault entry without rewriting the rest. ' +
      'Each edit swaps old_string for new_string. old_string must match the notes from entry_info exactly, ' +
      'spaces and line breaks included, and match only once unless replace_all is true. ' +
      'Edits apply in order; if any edit fails, nothing is saved. ' +
      SECRET_TOKENS_HELP + ' ' +
      'IMPORTANT: Always show the user each change and get their approval before calling this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry to update' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TEXT_EDITS,
          description: 'Changes to make, applied in order',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description: 'Exact text to replace. Include enough nearby text to match once. Empty only when the notes are empty.',
              },
              new_string: { type: 'string', description: 'Text to put in its place. Use an empty string to delete.' },
              replace_all: { type: 'boolean', description: 'Replace every match of old_string. Default: false' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['entry_id', 'edits'],
    },
  };
}

export async function entryEditNotes(
  client: ConduitClient,
  args: { entry_id: string; edits: unknown },
): Promise<unknown> {
  const edits = parseTextEdits(args.edits);
  const current = await client.entryGetInfo(args.entry_id, true);
  const redacted = redactSecrets(textField(current.notes));
  const edited = applyTextEdits(redacted.text, edits);
  const restored = restoreSecrets(edited.text, redacted);
  const result = await client.entryUpdateNotes(args.entry_id, restored.text);
  return { ...result, replacements: edited.replacements, secrets_removed: restored.secretsRemoved };
}

// ---------- document_create ----------

export function documentCreateDefinition() {
  return {
    name: 'document_create',
    description:
      'Create a new markdown document entry in the vault. ' +
      SECRET_TOKENS_HELP + ' ' +
      'IMPORTANT: Always show the user the proposed document name and content, and get their approval before calling this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Document name' },
        content: { type: 'string', description: 'Markdown content' },
        folder_id: { type: 'string', description: 'Folder UUID to create the document in (optional, defaults to vault root)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for organization',
        },
      },
      required: ['name', 'content'],
    },
  };
}

export async function documentCreate(
  client: ConduitClient,
  args: { name: string; content: string; folder_id?: string; tags?: string[] },
): Promise<unknown> {
  return client.documentCreate(
    args.name,
    args.content,
    args.folder_id ?? null,
    args.tags ?? [],
  );
}

// ---------- document_update ----------

export function documentUpdateDefinition() {
  return {
    name: 'document_update',
    description:
      'Update the content of an existing markdown document entry. ' +
      SECRET_TOKENS_HELP + ' ' +
      'IMPORTANT: Always show the user the proposed changes and get their approval before calling this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the document entry to update' },
        content: { type: 'string', description: 'New markdown content (replaces existing content)' },
        name: { type: 'string', description: 'New document name (optional, keeps existing if omitted)' },
      },
      required: ['entry_id', 'content'],
    },
  };
}

export async function documentUpdate(
  client: ConduitClient,
  args: { entry_id: string; content: string; name?: string },
): Promise<unknown> {
  if (typeof args.content !== 'string') throw new Error('content must be a string.');
  const current = await client.entryGetDocument(args.entry_id);
  const restored = restoreSecrets(args.content, redactSecrets(textField(current.content)));
  const result = await client.documentUpdate(args.entry_id, restored.text, args.name ?? null);
  return { ...result, secrets_removed: restored.secretsRemoved };
}

// ---------- entry_list ----------

export function entryListDefinition() {
  return {
    name: 'entry_list',
    description:
      'List vault entries, optionally filtered by entry_type, folder_id, or tags. ' +
      'Returns metadata only (no notes or secrets). Use entry_info to read notes for a specific entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_type: {
          type: 'string',
          description: 'Filter by entry type: "ssh", "rdp", "vnc", "web", "credential", "document", "command"',
        },
        folder_id: {
          type: 'string',
          description: 'Filter to entries inside this folder UUID. Pass empty string for root entries.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to entries that have ALL of these tags',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (default: no cap)',
        },
      },
      required: [],
    },
  };
}

export async function entryList(
  client: ConduitClient,
  args: { entry_type?: string; folder_id?: string; tags?: string[]; limit?: number },
): Promise<unknown> {
  const folderId = args.folder_id === undefined ? null : (args.folder_id || null);
  const entries = await client.entryList(
    args.entry_type ?? null,
    folderId,
    args.tags ?? null,
    args.limit ?? null,
  );
  return { entries };
}

// ---------- entry_search ----------

export function entrySearchDefinition() {
  return {
    name: 'entry_search',
    description:
      'Search vault entries by name or host (case-insensitive substring match). ' +
      'Returns metadata only (no notes or secrets).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (matches name and host substrings)' },
        entry_type: {
          type: 'string',
          description: 'Optional filter by entry type ("ssh", "document", etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 50)',
        },
      },
      required: ['query'],
    },
  };
}

export async function entrySearch(
  client: ConduitClient,
  args: { query: string; entry_type?: string; limit?: number },
): Promise<unknown> {
  const entries = await client.entrySearch(args.query, args.entry_type ?? null, args.limit ?? null);
  return { entries };
}

// ---------- ssh_key_generate ----------

export function sshKeyGenerateDefinition() {
  return {
    name: 'ssh_key_generate',
    description:
      'Generate a new SSH key pair and store it as an SSH-key credential in the vault. ' +
      'Returns the new credential_id, fingerprint, and public key. The private key is stored ' +
      'encrypted in the vault and is NOT returned by this tool — use credential_read (with approval) ' +
      'to retrieve it. REQUIRES USER APPROVAL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Credential name (shown in the vault)' },
        type: {
          type: 'string',
          description: 'Key type: "ed25519" (recommended), "rsa", or "ecdsa"',
        },
        bits: {
          type: 'number',
          description: 'For RSA: 2048 or 4096 (default 4096). Ignored for ed25519/ecdsa.',
        },
        curve: {
          type: 'string',
          description: 'For ECDSA: "P-256" (default), "P-384", or "P-521". Ignored for other types.',
        },
        comment: {
          type: 'string',
          description: 'Optional comment string embedded in the public key (e.g., "user@host")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the new credential',
        },
      },
      required: ['name', 'type'],
    },
  };
}

export async function sshKeyGenerate(
  client: ConduitClient,
  args: {
    name: string;
    type: 'ed25519' | 'rsa' | 'ecdsa';
    bits?: number;
    curve?: string;
    comment?: string;
    tags?: string[];
  },
): Promise<unknown> {
  return client.sshKeyGenerate(
    args.name,
    args.type,
    args.bits ?? null,
    args.curve ?? null,
    args.comment ?? null,
    args.tags ?? [],
  );
}
