// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { readEmbedded } from '../../knowledge/kb-model.js';
import { parseRefs } from '../secret-refs.js';
import {
  cleanupOrphans,
  cloneBorrowedSecrets,
  commitRotation,
  createEmbeddedSecret,
  discardRotation,
  encryptAllPlaintext,
  ownedSecrets,
  stageRotation,
  updateWithSecrets,
} from '../embedded-secrets.js';

let dir: string;
let vault: ConduitVault;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-embedded-'));
  vault = new ConduitVault(path.join(dir, 'v.conduit'));
  vault.initialize('pw-for-tests');
});

afterAll(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

const newAsset = (name: string, notes: string | null = null) => vault.createEntry({ name, entry_type: 'ssh', host: 'h', notes });

describe('updateWithSecrets', () => {
  it('turns !!value!! into encrypted hidden secrets and stores only refs', () => {
    const asset = newAsset('web-01');
    const { entry, converted } = updateWithSecrets(vault, asset.id, { notes: 'Admin pw: !!hunter2!!\nDB: !!hunter2!!' });
    expect(converted).toBe(1);
    const [ref] = parseRefs(entry.notes!);
    expect(entry.notes).toBe(`Admin pw: {{secret:${ref.id}|Admin pw}}\nDB: {{secret:${ref.id}|Admin pw}}`);
    expect(entry.notes).not.toContain('hunter2');

    const secret = vault.getEntry(ref.id);
    expect(secret.password).toBe('hunter2');
    expect(secret.parent_entry_id).toBe(asset.id);
    expect(readEmbedded(secret.config)).toEqual({ owner_id: asset.id, label: 'Admin pw' });
    // Never offered as a login credential or in credential lists.
    expect(vault.listCredentials().some((c) => c.id === ref.id)).toBe(false);
  });

  it('shares one secret between notes and document content in the same save', () => {
    const doc = vault.createEntry({ name: 'Doc', entry_type: 'document', config: { content: '' } });
    const { converted, entry } = updateWithSecrets(vault, doc.id, { notes: 'k: !!same!!', config: { content: 'Key: !!same!!' } });
    expect(converted).toBe(1);
    expect(parseRefs(entry.notes!)[0].id).toBe(parseRefs(entry.config.content as string)[0].id);
  });

  it('flags secrets no text references, and clears the flag when a ref comes back', () => {
    const asset = newAsset('db-01');
    const { entry } = updateWithSecrets(vault, asset.id, { notes: 'root: !!r00t-pass!!' });
    const ref = entry.notes!;
    updateWithSecrets(vault, asset.id, { notes: 'nothing here' });
    const [secret] = ownedSecrets(vault, asset.id);
    expect(readEmbedded(secret.config)?.orphaned_at).toBeTruthy();

    updateWithSecrets(vault, asset.id, { notes: ref });
    expect(readEmbedded(ownedSecrets(vault, asset.id)[0].config)?.orphaned_at).toBeUndefined();

    updateWithSecrets(vault, asset.id, { notes: '' });
    expect(cleanupOrphans(vault, asset.id)).toBe(1);
    expect(ownedSecrets(vault, asset.id)).toHaveLength(0);
  });

  it('leaves other updates alone', () => {
    const asset = newAsset('plain', 'pw !!legacy!!');
    const { converted, entry } = updateWithSecrets(vault, asset.id, { is_favorite: true });
    expect(converted).toBe(0);
    expect(entry.notes).toBe('pw !!legacy!!');
  });
});

describe('deleting an owner', () => {
  it('deletes its embedded secrets and keeps normal children', () => {
    const asset = newAsset('to-delete');
    const { entry } = updateWithSecrets(vault, asset.id, { notes: 'x: !!gone-soon!!' });
    const secretId = parseRefs(entry.notes!)[0].id;
    const child = vault.createEntry({ name: 'child', entry_type: 'ssh', parent_entry_id: asset.id });
    vault.deleteEntry(asset.id);
    expect(() => vault.getEntry(secretId)).toThrow();
    expect(vault.getEntryMeta(child.id).parent_entry_id).toBeNull();
  });

  it('does not let a nested connection inherit an embedded secret', () => {
    const asset = newAsset('parent');
    updateWithSecrets(vault, asset.id, { notes: 'x: !!not-a-login!!' });
    const child = vault.createEntry({ name: 'child', entry_type: 'ssh', parent_entry_id: asset.id });
    expect(vault.resolveCredential(child.id)).toBeNull();
  });
});

describe('cloneBorrowedSecrets', () => {
  it('gives a duplicate its own copies', () => {
    const asset = newAsset('orig');
    updateWithSecrets(vault, asset.id, { notes: 'pw: !!dup-me!!' });
    const copy = vault.duplicateEntry(asset.id);
    expect(cloneBorrowedSecrets(vault, asset.id, copy.id)).toBe(1);
    const copyRef = parseRefs(vault.getEntryMeta(copy.id).notes!)[0];
    expect(readEmbedded(vault.getEntryMeta(copyRef.id).config)?.owner_id).toBe(copy.id);
    expect(vault.getEntry(copyRef.id).password).toBe('dup-me');
    vault.deleteEntry(asset.id);
    expect(vault.getEntry(copyRef.id).password).toBe('dup-me');
  });
});

describe('rotation', () => {
  it('stages, commits into history, and discards', () => {
    const asset = newAsset('rot');
    const { id } = createEmbeddedSecret(vault, asset.id, 'Local admin', 'old-value');
    stageRotation(vault, id, 'new-value');
    commitRotation(vault, id, 'Claude Code');
    expect(vault.getEntry(id).password).toBe('new-value');
    expect(vault.listPasswordHistory(id)[0].password).toBe('old-value');
    expect(ownedSecrets(vault, asset.id)).toHaveLength(1);

    stageRotation(vault, id, 'third');
    expect(discardRotation(vault, id)).toBe(true);
    expect(vault.getEntry(id).password).toBe('new-value');
    expect(() => commitRotation(vault, id, null)).toThrow(/no staged rotation/);
  });
});

describe('encryptAllPlaintext', () => {
  it('converts every entry that still has !!value!!', () => {
    newAsset('legacy-a', 'a: !!one!!');
    newAsset('legacy-b', 'b: !!two!! c: !!three!!');
    const result = encryptAllPlaintext(vault);
    expect(result.secrets).toBeGreaterThanOrEqual(3);
    expect(vault.listEntries().some((e) => e.notes?.includes('!!'))).toBe(false);
  });
});
