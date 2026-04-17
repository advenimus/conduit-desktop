/**
 * Entry & document MCP tools.
 *
 * Read tools apply automatic !!secret!! redaction.
 * Write tools (update notes, create/update documents) modify the vault.
 */

import type { ConduitClient } from '../ipc-client.js';
import { maskSecrets } from '../mask-secrets.js';

// ---------- entry_info ----------

export function entryInfoDefinition() {
  return {
    name: 'entry_info',
    description:
      'Get metadata for any vault entry (connection, document, command). ' +
      'Optionally include notes with !!secret!! values redacted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: { type: 'string', description: 'UUID of the entry' },
        include_notes: {
          type: 'boolean',
          description: 'Include the entry notes field (secrets redacted). Default: false',
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
    is_favorite: entry.is_favorite ?? false,
    credential_id: entry.credential_id ?? null,
    username: entry.username ?? null,
    domain: entry.domain ?? null,
    created_at: entry.created_at ?? '',
    updated_at: entry.updated_at ?? '',
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
      'Read the markdown content of a document entry. !!secret!! values are automatically redacted.',
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
      'Update the markdown notes on any vault entry. ' +
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
  return client.entryUpdateNotes(args.entry_id, args.notes);
}

// ---------- document_create ----------

export function documentCreateDefinition() {
  return {
    name: 'document_create',
    description:
      'Create a new markdown document entry in the vault. ' +
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
  return client.documentUpdate(args.entry_id, args.content, args.name ?? null);
}
