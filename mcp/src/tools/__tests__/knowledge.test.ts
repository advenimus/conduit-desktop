// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { kbImportNotes, kbRead, kbSearch, kbWrite } from '../knowledge.js';

function client(article: Record<string, unknown>, notes = '') {
  const kbRequest = vi.fn(async (type: string, payload: Record<string, unknown>) => (type === 'KbRead' ? article : { ok: true, type, payload }));
  const entryGetInfo = vi.fn(async () => ({ notes }));
  return { kbRequest, entryGetInfo, c: { kbRequest, entryGetInfo } as unknown as ConduitClient };
}

describe('knowledge tools', () => {
  it('kb_read masks legacy !!secrets!! and leaves refs', async () => {
    const { c } = client({ content: 'old: !!plain!! new: {{secret:11111111-2222-4333-8444-555555555555|x}}' });
    const out = (await kbRead(c, { article_id: 'a' })) as { content: string };
    expect(out.content).toBe('old: [SECRET_1] new: {{secret:11111111-2222-4333-8444-555555555555|x}}');
  });

  it('kb_search masks snippets', async () => {
    const kbRequest = vi.fn(async () => ({ results: [{ id: 'a', snippet: 'pw !!x!!' }] }));
    const out = (await kbSearch({ kbRequest } as unknown as ConduitClient, { query: 'pw' })) as { results: Array<{ snippet: string }> };
    expect(out.results[0].snippet).toBe('pw [SECRET_1]');
  });

  it('kb_write applies edits against the masked body and restores secrets', async () => {
    const { c, kbRequest } = client({ content: 'root: !!s3cret!!\nport 22' });
    const out = (await kbWrite(c, { article_id: 'a', edits: [{ old_string: 'port 22', new_string: 'port 2222' }], reason: 'moved' })) as Record<string, unknown>;
    expect(kbRequest).toHaveBeenLastCalledWith('KbWrite', { article_id: 'a', reason: 'moved', content: 'root: !!s3cret!!\nport 2222' });
    expect([out.replacements, out.secrets_removed]).toEqual([1, 0]);
  });

  it('kb_write passes a create straight through and refuses edits without an article', async () => {
    const { c, kbRequest } = client({});
    await kbWrite(c, { scope: 'vault', kind: 'playbook', title: 'Patch', content: 'x' });
    expect(kbRequest).toHaveBeenLastCalledWith('KbWrite', { scope: 'vault', kind: 'playbook', title: 'Patch', content: 'x' });
    await expect(kbWrite(c, { edits: [] })).rejects.toThrow(/article_id/);
  });

  it('kb_import_notes carries [SECRET_n] tokens from the notes into articles', async () => {
    const { c, kbRequest } = client({}, 'admin: !!pw-1!!');
    await kbImportNotes(c, { entry_id: 'e', articles: [{ title: 'Access', kind: 'facts', content: 'admin: [SECRET_1]' }] });
    expect(kbRequest).toHaveBeenLastCalledWith('KbImportNotes', { entry_id: 'e', articles: [{ title: 'Access', kind: 'facts', content: 'admin: !!pw-1!!' }] });
  });
});
