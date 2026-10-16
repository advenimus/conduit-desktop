// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConduitVault } from '../vault.js';
import { exportVault, importIntoVault, remapGatewayId } from '../export-import.js';

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

describe('remapGatewayId', () => {
  const ids = new Map([['old-gw', 'new-gw']]);

  it('leaves a config without a gateway alone', () => {
    const config = { colorDepth: 24 };
    expect(remapGatewayId(config, ids)).toBe(config);
    expect(remapGatewayId(undefined, ids)).toBeUndefined();
  });

  it('points the entry at the imported gateway', () => {
    const config = { gatewayId: 'old-gw', colorDepth: 24 };
    expect(remapGatewayId(config, ids)).toEqual({ gatewayId: 'new-gw', colorDepth: 24 });
    expect(config.gatewayId).toBe('old-gw');
  });

  it('drops a gateway that was not imported', () => {
    expect(remapGatewayId({ gatewayId: 'elsewhere', colorDepth: 24 }, ids)).toEqual({ colorDepth: 24 });
  });
});

describe('export and import with a gateway', () => {
  it('keeps the RDP entry, gateway and linked login together', () => {
    const src = open('src-full');
    // Named so the gateway sorts before its login in the export.
    const gw = src.createEntry({
      name: 'A gateway',
      entry_type: 'credential',
      credential_type: 'rd_gateway',
      config: { gatewayHostname: 'gw.corp.example', gatewayPort: 8443 },
    });
    const cred = src.createEntry({ name: 'Z login', entry_type: 'credential', username: 'gwuser', password: 'gw-pw' });
    src.updateEntry(gw.id, { credential_id: cred.id });
    src.createEntry({ name: 'pc01', entry_type: 'rdp', host: 'pc01.corp.local', config: { gatewayId: gw.id, colorDepth: 24 } });
    const file = path.join(dir, 'full.conduit-export');
    exportVault(src, { scope: 'full', passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst-full');
    importIntoVault(dst, file, 'export-pass-1');
    const entries = dst.listEntries();
    const newGw = entries.find((e) => e.name === 'A gateway')!;
    const newCred = entries.find((e) => e.name === 'Z login')!;
    const rdp = entries.find((e) => e.name === 'pc01')!;
    expect(newGw.id).not.toBe(gw.id);
    expect(newGw.credential_type).toBe('rd_gateway');
    expect(newGw.config).toMatchObject({ gatewayHostname: 'gw.corp.example', gatewayPort: 8443 });
    expect(newGw.credential_id).toBe(newCred.id);
    expect(rdp.config).toEqual({ gatewayId: newGw.id, colorDepth: 24 });
    src.lock();
    dst.lock();
  });

  it('keeps a gateway\'s typed-in login', () => {
    const src = open('src-typed');
    const gw = src.createEntry({
      name: 'GW',
      entry_type: 'credential',
      credential_type: 'rd_gateway',
      username: 'gwuser',
      password: 'gw-pw',
      domain: 'CORP',
      config: { gatewayHostname: 'gw.corp.example' },
    });
    src.createEntry({ name: 'pc', entry_type: 'rdp', host: 'pc', config: { gatewayId: gw.id } });
    const file = path.join(dir, 'typed.conduit-export');
    exportVault(src, { scope: 'full', passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst-typed');
    importIntoVault(dst, file, 'export-pass-1');
    const newGw = dst.listEntries().find((e) => e.name === 'GW')!;
    const full = dst.getEntry(newGw.id);
    expect(full).toMatchObject({ username: 'gwuser', password: 'gw-pw', domain: 'CORP', credential_id: null });
    src.lock();
    dst.lock();
  });

  it('drops the gateway when it is outside the export', () => {
    const src = open('src-folder');
    const gw = src.createEntry({
      name: 'GW',
      entry_type: 'credential',
      credential_type: 'rd_gateway',
      config: { gatewayHostname: 'gw.corp.example' },
    });
    const folder = src.createFolder({ name: 'Client' });
    src.createEntry({ name: 'pc02', entry_type: 'rdp', host: 'pc02.corp.local', folder_id: folder.id, config: { gatewayId: gw.id } });
    const file = path.join(dir, 'folder.conduit-export');
    exportVault(src, { scope: 'folder', folderIds: [folder.id], passphrase: 'export-pass-1', outputPath: file });

    const dst = open('dst-folder');
    importIntoVault(dst, file, 'export-pass-1');
    const rdp = dst.listEntries().find((e) => e.name === 'pc02')!;
    expect(rdp.config).not.toHaveProperty('gatewayId');
    src.lock();
    dst.lock();
  });
});
