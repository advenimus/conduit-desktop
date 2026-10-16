import { describe, it, expect } from 'vitest';
import { gatewayInfo, type GatewayInfoVault } from '../gateway-info.js';

const gw = {
  id: 'gw-1',
  name: 'Corp GW',
  entry_type: 'credential',
  credential_type: 'rd_gateway',
  config: { gatewayHostname: 'gw.corp.example', gatewayPort: 8443, gatewayLoginSource: 'connection' },
};
const cred = { id: 'cred-1', name: 'Admin', entry_type: 'credential', credential_type: null, config: {} };

const vault: GatewayInfoVault = {
  getEntryMeta: (id) => {
    const e = [gw, cred].find((x) => x.id === id);
    if (!e) throw new Error(`Entry not found: ${id}`);
    return e;
  },
};

const rdp = (config: Record<string, unknown>) => ({ id: 'pc', name: 'PC', entry_type: 'rdp', credential_type: null, config });

describe('gatewayInfo', () => {
  it('names the gateway an RDP entry uses', () => {
    expect(gatewayInfo(vault, rdp({ gatewayId: 'gw-1' }))).toEqual({
      gateway: { id: 'gw-1', name: 'Corp GW', address: 'gw.corp.example:8443' },
    });
  });

  it('adds nothing for an RDP entry without a gateway or for other entries', () => {
    expect(gatewayInfo(vault, rdp({}))).toEqual({});
    expect(gatewayInfo(vault, { ...cred, config: { gatewayId: 'gw-1' } })).toEqual({});
  });

  it('flags a gateway that was deleted or is not a gateway', () => {
    const missing = { gateway: { id: 'gone', name: null, address: null, missing: true } };
    expect(gatewayInfo(vault, rdp({ gatewayId: 'gone' }))).toEqual(missing);
    expect(gatewayInfo(vault, rdp({ gatewayId: 'cred-1' }))).toEqual({ gateway: { ...missing.gateway, id: 'cred-1' } });
  });

  it('shows a gateway entry\'s settings', () => {
    expect(gatewayInfo(vault, gw)).toEqual({
      gateway_settings: {
        address: 'gw.corp.example:8443',
        hostname: 'gw.corp.example',
        port: 8443,
        transport: 'auto',
        bypass_local: false,
        login_source: 'rdp_entry',
      },
    });
    expect(gatewayInfo(vault, { ...gw, config: { gatewayHostname: 'gw' } })).toMatchObject({
      gateway_settings: { address: 'gw', port: 443, login_source: 'gateway' },
    });
  });

  it('names the saved credential a gateway signs in with, by id only', () => {
    const linked = { ...gw, config: { gatewayHostname: 'gw', gatewayLoginSource: 'credential', gatewayCredentialId: 'cred-1' } };
    expect(gatewayInfo(vault, linked)).toMatchObject({
      gateway_settings: { login_source: 'saved_credential', credential_id: 'cred-1' },
    });
  });

  it('reads an older gateway that linked its credential in the credential_id column', () => {
    const older = { ...gw, config: { gatewayHostname: 'gw', gatewayLoginSource: 'own' }, credential_id: 'cred-1' };
    expect(gatewayInfo(vault, older)).toMatchObject({
      gateway_settings: { login_source: 'saved_credential', credential_id: 'cred-1' },
    });
  });

  it('reports a vault that cannot be read instead of a deleted gateway', () => {
    const locked: GatewayInfoVault = {
      getEntryMeta: () => {
        throw new Error('Vault is not unlocked');
      },
    };
    expect(() => gatewayInfo(locked, rdp({ gatewayId: 'gw-1' }))).toThrow('Vault is not unlocked');
  });
});
