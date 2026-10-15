// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const { parentsFirst } = await import('../team-sync.js');

describe('parentsFirst', () => {
  it('puts parents before children whatever order the server returns', () => {
    const rows = [
      { id: 'secret', parent_entry_id: 'article' },
      { id: 'article', parent_entry_id: 'asset' },
      { id: 'other', parent_entry_id: null },
      { id: 'asset', parent_entry_id: null },
      { id: 'orphan', parent_entry_id: 'not-in-list' },
    ];
    const order = parentsFirst(rows).map((r) => r.id);
    expect(order).toHaveLength(5);
    expect(order.indexOf('asset')).toBeLessThan(order.indexOf('article'));
    expect(order.indexOf('article')).toBeLessThan(order.indexOf('secret'));
  });

  it('survives a parent cycle', () => {
    expect(parentsFirst([{ id: 'a', parent_entry_id: 'b' }, { id: 'b', parent_entry_id: 'a' }]).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
