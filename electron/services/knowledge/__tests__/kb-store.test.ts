// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { readKb } from '../kb-model.js';
import { readHistory } from '../kb-revisions.js';
import { createArticle, keepAgentEdits, restoreRevision, undoAgentEdits, updateArticle, verifyArticle } from '../kb-store.js';
import { knowledgeBlock, knowledgeContext, readArticle, searchKnowledge } from '../kb-query.js';
import { dismissMigration, logChange, splitNotesIntoArticles } from '../kb-notes.js';
import { parseRefs } from '../../secrets/secret-refs.js';

let dir: string;
let vault: ConduitVault;
const claude = { kind: 'agent' as const, name: 'Claude Code' };
const me = { kind: 'user' as const, device: 'desktop' as const };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-kb-'));
  vault = new ConduitVault(path.join(dir, 'v.conduit'));
  vault.initialize('pw-for-tests');
});

afterAll(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

const asset = (name: string, extra: Partial<Parameters<ConduitVault['createEntry']>[0]> = {}) =>
  vault.createEntry({ name, entry_type: 'ssh', host: 'h', ...extra });

describe('articles', () => {
  it('creates an asset article with a revision, pinning the first overview', () => {
    const a = asset('web-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Overview', kind: 'overview', content: '# web-01\nNginx front end.' }, claude);
    const kb = readKb(art.config)!;
    expect([art.parent_entry_id, art.folder_id, kb.pinned, kb.summary, kb.author]).toEqual([a.id, null, true, 'web-01', claude]);
    expect(readHistory(art.config)).toHaveLength(1);
    const second = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Overview 2', kind: 'overview', content: 'x' }, claude);
    expect(readKb(second.config)!.pinned).toBe(false);
    expect(vault.listCredentials().some((c) => c.id === art.id)).toBe(false);
  });

  it('encrypts secrets written into article content', () => {
    const a = asset('db-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Access', kind: 'facts', content: 'root: !!r00t-db!!' }, claude);
    const content = art.config.content as string;
    const [ref] = parseRefs(content);
    expect(content).toBe(`root: {{secret:${ref.id}|root}}`);
    expect(vault.getEntry(ref.id).password).toBe('r00t-db');
    expect(readHistory(art.config)[0].content).toBe(content);
    // The summary is plain text and must not keep the value either.
    expect(readKb(art.config)!.summary).toBe('root: ••••');
    expect(JSON.stringify(art)).not.toContain('r00t-db');
  });

  it('never keeps a secret in a summary or title the caller gives', () => {
    const a = asset('db-02');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'pw !!t1tle-pw!!', kind: 'facts', content: 'x', summary: 'pw !!summ-pw!!' }, claude);
    expect([art.name, readKb(art.config)!.summary]).toEqual(['pw ••••', 'pw ••••']);
    const updated = updateArticle(vault, art.id, { summary: 'now !!other-pw!!' }, claude);
    expect(readKb(updated.config)!.summary).toBe('now ••••');
  });

  it('keeps a derived summary in step with the body, but not one someone wrote', () => {
    const a = asset('sum-01');
    const derived = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'D', kind: 'facts', content: 'first line\nmore' }, me);
    expect(readKb(updateArticle(vault, derived.id, { content: 'new first line' }, me).config)!.summary).toBe('new first line');
    const written = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'W', kind: 'facts', content: 'body', summary: 'My summary' }, me);
    expect(readKb(updateArticle(vault, written.id, { content: 'other body' }, me).config)!.summary).toBe('My summary');
  });

  it('rejects bad placement', () => {
    expect(() => createArticle(vault, { scope: 'folder', folder_id: 'nope', title: 't', kind: 'facts', content: '' }, me)).toThrow(/folder/);
    expect(() => createArticle(vault, { scope: 'asset', title: 't', kind: 'facts', content: '' }, me)).toThrow(/entry_id/);
    expect(() => createArticle(vault, { scope: 'vault', title: ' ', kind: 'facts', content: '' }, me)).toThrow(/title/);
  });
});

describe('review and undo', () => {
  it('flags agent edits, keeps or undoes them, and restores old revisions', () => {
    const a = asset('app-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Steps', kind: 'procedure', content: 'v1' }, me);
    updateArticle(vault, art.id, { content: 'v2 by agent', reason: 'learned' }, claude);
    expect(readArticle(vault, art.id).unseen_agent_edit).toBe(true);

    const undone = undoAgentEdits(vault, art.id)!;
    expect(undone.config.content).toBe('v1');
    expect(readArticle(vault, art.id).unseen_agent_edit).toBe(false);

    updateArticle(vault, art.id, { content: 'v3 by agent' }, claude);
    keepAgentEdits(vault, art.id);
    expect(readArticle(vault, art.id).unseen_agent_edit).toBe(false);

    const first = readArticle(vault, art.id).history[0];
    expect(restoreRevision(vault, art.id, first.at).config.content).toBe('v1');
    expect(readArticle(vault, art.id).history.map((h) => h.editor)).toEqual(['You', 'Claude Code', 'You', 'Claude Code', 'You']);
  });

  it('offers no undo for an agent-created article never reviewed', () => {
    const a = asset('new-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Found', kind: 'facts', content: 'x' }, claude);
    expect(undoAgentEdits(vault, art.id)).toBeNull();
  });

  it('records verification and needs-review', () => {
    const a = asset('ver-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: a.id, title: 'Disk', kind: 'facts', content: 'x' }, me);
    expect(readKb(verifyArticle(vault, art.id, false, 'disk replaced', claude).config)!.status).toBe('needs_review');
    const ok = readKb(verifyArticle(vault, art.id, true, undefined, claude).config)!;
    expect([ok.status, !!ok.verified_at, ok.verified_by]).toEqual(['active', true, claude]);
  });
});

describe('context, search and the entry_info block', () => {
  it('inherits folder and vault knowledge, finds articles, and suggests migration', () => {
    const client = vault.createFolder({ name: 'Client X' });
    const host = asset('mail-01', { folder_id: client.id, tags: ['exchange'], notes: '## Setup\nstep one\n## Contacts\nBob' });
    createArticle(vault, { scope: 'folder', folder_id: client.id, title: 'Network map', kind: 'facts', content: 'VLAN 20 is servers' }, me);
    createArticle(vault, { scope: 'vault', title: 'Exchange patching', kind: 'playbook', content: 'Drain first', tags: ['Exchange'] }, me);

    const ctx = knowledgeContext(vault, { entry_id: host.id });
    expect(ctx.map((a) => [a.title, a.group])).toEqual([['Network map', 'folder'], ['Exchange patching', 'vault']]);
    expect(ctx[0].folder).toBe('Client X');

    expect(searchKnowledge(vault, 'vlan')[0].title).toBe('Network map');
    expect(searchKnowledge(vault, 'patching drain', { entry_id: host.id })[0].title).toBe('Exchange patching');

    const block = knowledgeBlock(vault, vault.getEntryMeta(host.id));
    expect(block.migration_suggested).toBe('headings');
    dismissMigration(vault, host.id);
    expect(knowledgeBlock(vault, vault.getEntryMeta(host.id)).migration_suggested).toBeNull();
  });

  it('splits notes into articles by heading', () => {
    const host = asset('split-01', { notes: 'Intro\n## Reboot steps\n1. a\n## Known issues\nDisk fills' });
    const made = splitNotesIntoArticles(vault, host.id, 'pointer');
    expect(made.map((m) => [m.name, readKb(m.config)!.kind])).toEqual([['Overview', 'overview'], ['Reboot steps', 'procedure'], ['Known issues', 'troubleshooting']]);
    expect(vault.getEntryMeta(host.id).notes).toBe('Moved to Knowledge. See the Knowledge tab.');
  });
});

describe('change log', () => {
  it('creates the change log, then adds lines newest first', () => {
    const host = asset('log-01');
    logChange(vault, host.id, 'Installed nginx', claude);
    const log = logChange(vault, host.id, 'Rotated the admin password', me);
    const lines = (log.config.content as string).split('\n');
    expect(lines[0]).toBe('# Change log');
    expect(lines[2]).toMatch(/UTC · You: Rotated the admin password$/);
    expect(lines[3]).toMatch(/UTC · Claude Code: Installed nginx$/);
  });

  it('deletes articles with their asset', () => {
    const host = asset('gone-01');
    const art = createArticle(vault, { scope: 'asset', entry_id: host.id, title: 'x', kind: 'facts', content: 'pw: !!soon-gone!!' }, me);
    const secretId = parseRefs(art.config.content as string)[0].id;
    vault.deleteEntry(host.id);
    expect(() => vault.getEntryMeta(art.id)).toThrow();
    expect(() => vault.getEntryMeta(secretId)).toThrow();
  });
});
