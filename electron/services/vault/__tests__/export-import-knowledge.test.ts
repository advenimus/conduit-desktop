// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConduitVault } from '../vault.js';
import { exportVault, importIntoVault } from '../export-import.js';
import { createArticle } from '../../knowledge/kb-store.js';
import { updateWithSecrets } from '../../secrets/embedded-secrets.js';
import { readEmbedded, readKb } from '../../knowledge/kb-model.js';
import { parseRefs } from '../../secrets/secret-refs.js';

let dir: string;
const open = (name: string) => {
  const v = new ConduitVault(path.join(dir, `${name}.conduit`));
  v.initialize('pw-for-tests');
  return v;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-export-kb-'));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('export and import with knowledge and secret chips', () => {
  it('keeps nesting and re-points secret refs at the imported secrets', () => {
    const src = open('src');
    const folder = src.createFolder({ name: 'Client' });
    const asset = src.createEntry({ name: 'web-01', entry_type: 'ssh', host: 'h', folder_id: folder.id });
    updateWithSecrets(src, asset.id, { notes: 'root: !!n0tes-pw!!' });
    createArticle(src, { scope: 'asset', entry_id: asset.id, title: 'Access', kind: 'facts', content: 'api: !!art1cle-pw!!' }, { kind: 'user' });
    src.createEntry({ name: 'Run backup', entry_type: 'command', folder_id: folder.id, config: { command: 'backup.sh' } });

    const file = path.join(dir, 'x.conduit-export');
    exportVault(src, { scope: 'folder', folderIds: [folder.id], passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst');
    importIntoVault(dst, file, 'export-pass-1');
    const entries = dst.listEntries();
    const web = entries.find((e) => e.name === 'web-01')!;
    const article = entries.find((e) => readKb(e.config))!;
    expect(article.parent_entry_id).toBe(web.id);
    expect(entries.some((e) => e.entry_type === 'command')).toBe(true);

    const notesRef = parseRefs(web.notes!)[0];
    const articleRef = parseRefs(article.config.content as string)[0];
    expect(dst.getEntry(notesRef.id).password).toBe('n0tes-pw');
    expect(dst.getEntry(articleRef.id).password).toBe('art1cle-pw');
    expect(readEmbedded(dst.getEntryMeta(notesRef.id).config)?.owner_id).toBe(web.id);
    expect(readEmbedded(dst.getEntryMeta(articleRef.id).config)?.owner_id).toBe(article.id);
    expect(dst.getEntryMeta(articleRef.id).parent_entry_id).toBe(article.id);
    src.lock();
    dst.lock();
  });
});
