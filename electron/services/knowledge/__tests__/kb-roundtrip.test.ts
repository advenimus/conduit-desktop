// @vitest-environment node
// Desktop <-> iOS round trip of a real vault file (docs/KNOWLEDGE_BASE.md). Runs only with
// KB_ROUNDTRIP_DIR set:
//   KB_ROUNDTRIP_DIR=/tmp/kb-roundtrip npx vitest run electron/services/knowledge/__tests__/kb-roundtrip.test.ts
// The first run writes desktop.conduit there. The iOS test (KnowledgeRoundTripTests) opens it, checks
// it, edits it and saves ios.conduit next to it. A later run reads ios.conduit back.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { createArticle, updateArticle } from '../kb-store.js';
import { readArticle } from '../kb-query.js';
import { hasUnseenAgentEdit } from '../kb-revisions.js';
import { isHiddenEntry, readKb } from '../kb-model.js';
import { updateWithSecrets } from '../../secrets/embedded-secrets.js';
import { parseRefs } from '../../secrets/secret-refs.js';

const DIR = process.env.KB_ROUNDTRIP_DIR;
const PASSWORD = 'kb-roundtrip-pw-1';
const DESKTOP_FILE = 'desktop.conduit';
const IOS_FILE = 'ios.conduit';

export const ROUNDTRIP = {
  notesSecret: 'rt-notes-secret-3301',
  articleSecret: 'rt-article-secret-3302',
  iosSecret: 'rt-ios-secret-3303',
} as const;

describe.skipIf(!DIR)('desktop <-> iOS round trip', () => {
  it('writes the desktop vault', () => {
    const dir = DIR!;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, DESKTOP_FILE);
    fs.rmSync(file, { force: true });
    const vault = new ConduitVault(file);
    vault.initialize(PASSWORD);
    const folder = vault.createFolder({ name: 'Client RT' });
    const asset = vault.createEntry({ name: 'rt-web-01', entry_type: 'ssh', host: '10.99.0.1', folder_id: folder.id, tags: ['ubuntu'] });
    updateWithSecrets(vault, asset.id, { notes: `Admin pw: !!${ROUNDTRIP.notesSecret}!!` });
    const me = { kind: 'user' as const, device: 'desktop' as const };
    const agent = { kind: 'agent' as const, name: 'Claude Code' };
    createArticle(vault, { scope: 'asset', entry_id: asset.id, title: 'Overview', kind: 'overview', content: 'Web front end' }, me);
    const steps = createArticle(vault, { scope: 'asset', entry_id: asset.id, title: 'Restart', kind: 'procedure', content: '1. restart' }, me);
    updateArticle(vault, steps.id, { content: '1. reload', reason: 'reload keeps connections' }, agent);
    createArticle(vault, { scope: 'asset', entry_id: asset.id, title: 'Access', kind: 'facts', content: `api: !!${ROUNDTRIP.articleSecret}!!` }, agent);
    createArticle(vault, { scope: 'folder', folder_id: folder.id, title: 'Network', kind: 'facts', content: 'VLAN 99' }, me);
    createArticle(vault, { scope: 'vault', title: 'Patching', kind: 'playbook', content: 'apt upgrade', tags: ['Ubuntu'] }, me);
    vault.lock();
    expect(fs.existsSync(file)).toBe(true);
  });

  it.skipIf(!DIR || !fs.existsSync(path.join(DIR, IOS_FILE)))('reads back what iOS wrote', () => {
    const vault = new ConduitVault(path.join(DIR!, IOS_FILE));
    vault.unlock(PASSWORD);
    const entries = vault.listEntries();
    const asset = entries.find((e) => e.name === 'rt-web-01')!;
    expect(asset).toBeTruthy();

    // No plaintext !!secret!! anywhere, and every secret ref resolves.
    for (const e of entries) {
      for (const text of [e.notes, e.config?.content]) {
        if (typeof text !== 'string') continue;
        expect(text).not.toMatch(/!!.+?!!/);
        for (const ref of parseRefs(text)) expect(vault.getEntry(ref.id).password).toBeTruthy();
      }
    }
    expect(vault.getEntry(parseRefs(asset.notes!)[0].id).password).toBe(ROUNDTRIP.notesSecret);

    // iOS reviewed the agent's edit with Keep.
    const steps = entries.find((e) => e.name === 'Restart' && readKb(e.config))!;
    expect(hasUnseenAgentEdit(readKb(steps.config)!)).toBe(false);

    // iOS made an article with a new secret; its history records the iOS editor.
    const iosArticle = entries.find((e) => e.name === 'iOS notes' && readKb(e.config))!;
    expect(iosArticle.parent_entry_id).toBe(asset.id);
    const detail = readArticle(vault, iosArticle.id);
    const [ref] = parseRefs(detail.content);
    expect(vault.getEntry(ref.id).password).toBe(ROUNDTRIP.iosSecret);
    expect(readKb(iosArticle.config)!.last_editor).toMatchObject({ kind: 'user', device: 'ios' });
    expect(isHiddenEntry(iosArticle)).toBe(true);
    vault.lock();
  });
});
