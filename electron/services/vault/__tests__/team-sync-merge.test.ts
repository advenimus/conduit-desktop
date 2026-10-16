import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { TeamSyncService } from '../team-sync.js';
import { orderParentsFirst } from '../team-sync-order.js';
import { encrypt } from '../crypto.js';
import type { AuthService } from '../../auth/supabase.js';

describe('orderParentsFirst', () => {
  it('puts a parent before its child when the child comes first', () => {
    const rows = [
      { id: 'article', parent_entry_id: 'asset' },
      { id: 'secret', parent_entry_id: 'asset' },
      { id: 'asset', parent_entry_id: null },
    ];
    expect(orderParentsFirst(rows).map((r) => r.id)).toEqual(['asset', 'article', 'secret']);
  });

  it('handles nested chains', () => {
    const rows = [
      { id: 'c', parent_entry_id: 'b' },
      { id: 'b', parent_entry_id: 'a' },
      { id: 'a' },
    ];
    expect(orderParentsFirst(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps rows whose parent is not in the list, and cycles, without dropping any', () => {
    const rows = [
      { id: 'x', parent_entry_id: 'y' },
      { id: 'y', parent_entry_id: 'x' },
      { id: 'orphan', parent_entry_id: 'gone' },
    ];
    const ids = orderParentsFirst(rows).map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['x', 'y', 'orphan']));
  });

  it('does not change the input array', () => {
    const rows = [{ id: 'b', parent_entry_id: 'a' }, { id: 'a' }];
    orderParentsFirst(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

interface Row { id: string; parent_entry_id: string | null; updated_at: string }

function fakeVault() {
  const rows = new Map<string, Row>();
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  const vault = {
    getEntryMeta(id: string) {
      const row = rows.get(id);
      if (!row) throw new Error(`Entry not found: ${id}`);
      return row;
    },
    updateEntry(id: string, input: Record<string, unknown>) {
      updated.push({ id, input });
      const row = rows.get(id)!;
      rows.set(id, { ...row, parent_entry_id: (input.parent_entry_id as string | null | undefined) ?? row.parent_entry_id });
    },
    getDatabase: () => ({
      insertEntry(row: Record<string, unknown>) {
        const parent = row.parent_entry_id as string | null;
        if (parent && !rows.has(parent)) throw new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
        inserted.push(row);
        rows.set(row.id as string, { id: row.id as string, parent_entry_id: parent, updated_at: row.updated_at as string });
      },
    }),
    getEncryptionKey: () => randomBytes(32),
  };
  return { vault, rows, inserted, updated };
}

function serviceWith(vault: unknown, vek: Buffer): TeamSyncService {
  const svc = new TeamSyncService({} as AuthService);
  Object.assign(svc as unknown as Record<string, unknown>, { vault, vek });
  return svc;
}

function cloudRow(vek: Buffer, id: string, parent: string | null, updatedAt = '2026-10-16T10:00:00.000Z') {
  return {
    id,
    name: id,
    entry_type: 'document',
    parent_entry_id: parent,
    config_encrypted: encrypt(Buffer.from(JSON.stringify({ content: 'x' }), 'utf-8'), vek).toString('base64'),
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

function merge(svc: TeamSyncService, row: Record<string, unknown>): Promise<void> {
  return (svc as unknown as { mergeCloudEntry(r: Record<string, unknown>): Promise<void> }).mergeCloudEntry(row);
}

describe('TeamSyncService.mergeCloudEntry', () => {
  it('keeps the parent link when it creates a downloaded entry', async () => {
    const vek = randomBytes(32);
    const { vault, inserted } = fakeVault();
    const svc = serviceWith(vault, vek);
    await merge(svc, cloudRow(vek, 'asset', null));
    await merge(svc, cloudRow(vek, 'article', 'asset'));
    expect(inserted.find((r) => r.id === 'article')?.parent_entry_id).toBe('asset');
  });

  it('creates the entry at the top level when its parent is not in this vault', async () => {
    const vek = randomBytes(32);
    const { vault, inserted } = fakeVault();
    const svc = serviceWith(vault, vek);
    await merge(svc, cloudRow(vek, 'article', 'missing'));
    expect(inserted.find((r) => r.id === 'article')?.parent_entry_id).toBeNull();
  });

  it('applies a newer parent link to an entry that already exists', async () => {
    const vek = randomBytes(32);
    const { vault, rows, updated } = fakeVault();
    rows.set('asset', { id: 'asset', parent_entry_id: null, updated_at: '2026-10-16T09:00:00.000Z' });
    rows.set('article', { id: 'article', parent_entry_id: null, updated_at: '2026-10-16T09:00:00.000Z' });
    const svc = serviceWith(vault, vek);
    await merge(svc, cloudRow(vek, 'article', 'asset'));
    expect(updated).toHaveLength(1);
    expect(updated[0].input.parent_entry_id).toBe('asset');
  });
});
