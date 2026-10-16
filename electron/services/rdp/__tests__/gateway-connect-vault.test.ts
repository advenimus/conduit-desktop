// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConduitVault } from '../../vault/vault.js';
import { connectGateway } from '../gateway-connect.js';

let dir: string;
let vault: ConduitVault;
const hostLogin = { username: 'alice', password: 'host-pw' };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gw-vault-'));
  vault = new ConduitVault(path.join(dir, 'v.conduit'));
  vault.initialize('pw-for-tests');
});

afterAll(() => {
  vault.lock();
  fs.rmSync(dir, { recursive: true, force: true });
});

const createGateway = (over: Partial<Parameters<ConduitVault['createEntry']>[0]> = {}) =>
  vault.createEntry({
    name: 'Corp GW',
    entry_type: 'credential',
    credential_type: 'rd_gateway',
    config: { gatewayHostname: 'gw.corp.example' },
    ...over,
  });

describe('connectGateway with a real vault', () => {
  it('reads the typed-in login, decrypted', () => {
    const gw = createGateway({ username: 'gwuser', password: 'gw-pw' });
    expect(connectGateway(gw.id, hostLogin, vault)).toMatchObject({ username: 'gwuser', password: 'gw-pw' });
  });

  it('reads a linked credential and gives a clear error once it is deleted', () => {
    const cred = vault.createEntry({ name: 'GW login', entry_type: 'credential', username: 'linked', password: 'linked-pw' });
    const gw = createGateway({ credential_id: cred.id });
    expect(connectGateway(gw.id, hostLogin, vault)).toMatchObject({ username: 'linked', password: 'linked-pw' });

    vault.deleteEntry(cred.id);
    expect(vault.getEntry(gw.id).credential_id).toBeNull();
    expect(() => connectGateway(gw.id, hostLogin, vault)).toThrow('The gateway "Corp GW" has no login.');
  });

  it('reads a credential linked in the config and gives a clear error once it is deleted', () => {
    const cred = vault.createEntry({ name: 'GW login', entry_type: 'credential', username: 'linked2', password: 'linked2-pw' });
    const gw = createGateway({ config: { gatewayHostname: 'gw.corp.example', gatewayLoginSource: 'credential', gatewayCredentialId: cred.id } });
    expect(connectGateway(gw.id, hostLogin, vault)).toMatchObject({ username: 'linked2', password: 'linked2-pw' });

    vault.deleteEntry(cred.id);
    expect(() => connectGateway(gw.id, hostLogin, vault)).toThrow('The gateway "Corp GW" has no login.');
  });

  it('says the vault could not be read when it is locked, not that the gateway was deleted', () => {
    const locked = new ConduitVault(path.join(dir, 'locked.conduit'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => connectGateway('any-id', hostLogin, locked)).toThrow(/^Could not read the gateway from the vault: /);
    errorLog.mockRestore();
  });

  it('gives a clear error for an RDP entry whose gateway was deleted', () => {
    const gw = createGateway({ username: 'gwuser', password: 'gw-pw' });
    const pc = vault.createEntry({ name: 'pc', entry_type: 'rdp', host: 'pc', config: { gatewayId: gw.id } });
    vault.deleteEntry(gw.id);
    const gatewayId = vault.getEntry(pc.id).config.gatewayId as string;
    expect(() => connectGateway(gatewayId, hostLogin, vault)).toThrow(/was deleted/);
  });
});
