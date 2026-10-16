// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConduitVault } from '../vault.js';
import { exportVault, importIntoVault, remapGatewayCredential } from '../export-import.js';

let dir: string;
const open = (name: string) => {
  const v = new ConduitVault(path.join(dir, `${name}.conduit`));
  v.initialize('pw-for-tests');
  return v;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-export-gw-'));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('remapGatewayCredential', () => {
  const ids = new Map([['old-cred', 'new-cred']]);

  it('leaves a config without a gateway credential alone', () => {
    const config = { gatewayMode: 'custom', gatewayHostname: 'gw' };
    expect(remapGatewayCredential(config, ids)).toBe(config);
    expect(remapGatewayCredential(undefined, ids)).toBeUndefined();
  });

  it('points the gateway credential at the imported id', () => {
    const config = { gatewayCredentialMode: 'credential', gatewayCredentialId: 'old-cred', colorDepth: 24 };
    expect(remapGatewayCredential(config, ids)).toEqual({
      gatewayCredentialMode: 'credential',
      gatewayCredentialId: 'new-cred',
      colorDepth: 24,
    });
    expect(config.gatewayCredentialId).toBe('old-cred');
  });

  it('drops a link to a credential that was not imported', () => {
    expect(
      remapGatewayCredential({ gatewayCredentialMode: 'credential', gatewayCredentialId: 'elsewhere' }, ids),
    ).toEqual({ gatewayCredentialMode: 'same' });
  });
});

describe('export and import with a gateway credential', () => {
  it('keeps the link when the credential is in the export', () => {
    const src = open('src-full');
    const cred = src.createEntry({ name: 'GW login', entry_type: 'credential', username: 'gwuser', password: 'gw-pw' });
    src.createEntry({
      name: 'pc01',
      entry_type: 'rdp',
      host: 'pc01.corp.local',
      config: { gatewayMode: 'custom', gatewayHostname: 'gw.corp.example', gatewayCredentialMode: 'credential', gatewayCredentialId: cred.id },
    });
    const file = path.join(dir, 'full.conduit-export');
    exportVault(src, { scope: 'full', passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst-full');
    importIntoVault(dst, file, 'export-pass-1');
    const entries = dst.listEntries();
    const newCred = entries.find((e) => e.name === 'GW login')!;
    const rdp = entries.find((e) => e.name === 'pc01')!;
    expect(newCred.id).not.toBe(cred.id);
    expect(rdp.config.gatewayCredentialId).toBe(newCred.id);
    expect(rdp.config.gatewayCredentialMode).toBe('credential');
    src.lock();
    dst.lock();
  });

  it('falls back to the same login when the credential is outside the export', () => {
    const src = open('src-folder');
    const cred = src.createEntry({ name: 'GW login', entry_type: 'credential', username: 'gwuser', password: 'gw-pw' });
    const folder = src.createFolder({ name: 'Client' });
    src.createEntry({
      name: 'pc02',
      entry_type: 'rdp',
      host: 'pc02.corp.local',
      folder_id: folder.id,
      config: { gatewayCredentialMode: 'credential', gatewayCredentialId: cred.id },
    });
    const file = path.join(dir, 'folder.conduit-export');
    exportVault(src, { scope: 'folder', folderIds: [folder.id], passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst-folder');
    importIntoVault(dst, file, 'export-pass-1');
    const rdp = dst.listEntries().find((e) => e.name === 'pc02')!;
    expect(rdp.config.gatewayCredentialId).toBeUndefined();
    expect(rdp.config.gatewayCredentialMode).toBe('same');
    src.lock();
    dst.lock();
  });
});
