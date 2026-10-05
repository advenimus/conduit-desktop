// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { documentRead, documentUpdate, entryEditNotes, entryInfo, entryUpdateNotes } from '../entry.js';

const NOTES = '## Access\nroot: !!hunter2!!\nport: 22\n';

function makeClient(notes: string | null, content: string | null = null) {
  const entryUpdateNotesFn = vi.fn(async (id: string) => ({ id, name: 'Server', updated_at: 'now' }));
  const documentUpdateFn = vi.fn(async (id: string) => ({ id, name: 'Doc', updated_at: 'now' }));
  const client = {
    entryGetInfo: vi.fn(async () => ({ id: 'e1', name: 'Server', entry_type: 'ssh', notes })),
    entryGetDocument: vi.fn(async () => ({ id: 'd1', name: 'Doc', content })),
    entryUpdateNotes: entryUpdateNotesFn,
    documentUpdate: documentUpdateFn,
  } as unknown as ConduitClient;
  return { client, entryUpdateNotesFn, documentUpdateFn };
}

describe('entry_info notes', () => {
  it('shows secrets as numbered tokens', async () => {
    const { client } = makeClient(NOTES);
    const out = (await entryInfo(client, { entry_id: 'e1', include_notes: true })) as { notes: string };
    expect(out.notes).toBe('## Access\nroot: [SECRET_1]\nport: 22\n');
  });
});

describe('entry_edit_notes', () => {
  it('edits one line and keeps the hidden secret', async () => {
    const { client, entryUpdateNotesFn } = makeClient(NOTES);
    const out = (await entryEditNotes(client, {
      entry_id: 'e1',
      edits: [{ old_string: 'port: 22', new_string: 'port: 2222' }],
    })) as Record<string, unknown>;
    expect(entryUpdateNotesFn).toHaveBeenCalledWith('e1', '## Access\nroot: !!hunter2!!\nport: 2222\n');
    expect(out).toMatchObject({ id: 'e1', replacements: 1, secrets_removed: 0 });
  });

  it('rewrites a line that holds a secret by reusing its token', async () => {
    const { client, entryUpdateNotesFn } = makeClient(NOTES);
    await entryEditNotes(client, {
      entry_id: 'e1',
      edits: [{ old_string: 'root: [SECRET_1]', new_string: 'root (sudo): [SECRET_1]' }],
    });
    expect(entryUpdateNotesFn).toHaveBeenCalledWith('e1', '## Access\nroot (sudo): !!hunter2!!\nport: 22\n');
  });

  it('writes nothing when an edit fails', async () => {
    const { client, entryUpdateNotesFn } = makeClient(NOTES);
    await expect(
      entryEditNotes(client, { entry_id: 'e1', edits: [{ old_string: 'hunter2', new_string: 'x' }] }),
    ).rejects.toThrow(/not found/);
    expect(entryUpdateNotesFn).not.toHaveBeenCalled();
  });

  it('works on an entry with no notes yet', async () => {
    const { client, entryUpdateNotesFn } = makeClient(null);
    await entryEditNotes(client, { entry_id: 'e1', edits: [{ old_string: '', new_string: '# Server' }] });
    expect(entryUpdateNotesFn).toHaveBeenCalledWith('e1', '# Server');
  });

  it('rejects a missing or malformed edits list', async () => {
    const { client } = makeClient(NOTES);
    await expect(entryEditNotes(client, { entry_id: 'e1', edits: 'nope' as never })).rejects.toThrow(/edits/);
    await expect(
      entryEditNotes(client, { entry_id: 'e1', edits: [{ old_string: 'port', new_string: 5 as never }] }),
    ).rejects.toThrow(/new_string/);
  });
});

describe('entry_update_notes', () => {
  it('restores tokens from the current notes', async () => {
    const { client, entryUpdateNotesFn } = makeClient(NOTES);
    const out = (await entryUpdateNotes(client, { entry_id: 'e1', notes: '## Access\nroot: [SECRET_1]\n' })) as Record<string, unknown>;
    expect(entryUpdateNotesFn).toHaveBeenCalledWith('e1', '## Access\nroot: !!hunter2!!\n');
    expect(out.secrets_removed).toBe(0);
  });

  it('refuses the old [REDACTED] marker instead of saving it over the password', async () => {
    const { client, entryUpdateNotesFn } = makeClient(NOTES);
    await expect(entryUpdateNotes(client, { entry_id: 'e1', notes: 'root: [REDACTED]' })).rejects.toThrow(/\[REDACTED\]/);
    expect(entryUpdateNotesFn).not.toHaveBeenCalled();
  });
});

describe('document_read and document_update', () => {
  const CONTENT = 'API key: !!abc123!!';

  it('round-trips a document secret through its token', async () => {
    const { client, documentUpdateFn } = makeClient(null, CONTENT);
    const read = (await documentRead(client, { entry_id: 'd1' })) as { content: string };
    expect(read.content).toBe('API key: [SECRET_1]');
    await documentUpdate(client, { entry_id: 'd1', content: `${read.content}\nRotated: 2026-10` });
    expect(documentUpdateFn).toHaveBeenCalledWith('d1', 'API key: !!abc123!!\nRotated: 2026-10', null);
  });
});
