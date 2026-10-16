import { describe, it, expect, vi } from 'vitest';
import { GatewayConfigError } from '../gateway-config.js';
import {
  connectGateway,
  describeGateway,
  findRdGatewayEntry,
  loadRdGatewayRecord,
  parseGatewayIdArg,
  type GatewayVault,
  type GatewayVaultEntry,
} from '../gateway-connect.js';

function entry(over: Partial<GatewayVaultEntry> & { id: string }): GatewayVaultEntry {
  return {
    name: over.id,
    entry_type: 'credential',
    credential_type: null,
    config: {},
    credential_id: null,
    username: null,
    password: null,
    domain: null,
    ...over,
  };
}

function vaultOf(...entries: GatewayVaultEntry[]): GatewayVault & { getEntry: ReturnType<typeof vi.fn> } {
  return {
    getEntry: vi.fn((id: string) => {
      const e = entries.find((x) => x.id === id);
      if (!e) throw new Error(`Entry not found: ${id}`);
      return e;
    }),
  };
}

const gwConfig = { gatewayHostname: 'gw.corp.example' };
const hostLogin = { username: 'CORP\\alice', password: 'host-pw', domain: '' };

describe('loadRdGatewayRecord', () => {
  it('uses the typed-in login on the gateway entry', () => {
    const vault = vaultOf(
      entry({ id: 'gw', name: 'Corp GW', credential_type: 'rd_gateway', config: gwConfig, username: 'gwuser', password: 'gw-pw', domain: 'GW' }),
    );
    expect(loadRdGatewayRecord(vault, 'gw')).toEqual({
      id: 'gw',
      name: 'Corp GW',
      entryType: 'credential',
      credentialType: 'rd_gateway',
      config: gwConfig,
      ownLogin: { username: 'gwuser', password: 'gw-pw', domain: 'GW' },
    });
  });

  it('uses the linked credential over typed-in fields', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: gwConfig, credential_id: 'cred', username: 'stale', password: 'stale' }),
      entry({ id: 'cred', username: 'linked', password: 'linked-pw', domain: 'CORP' }),
    );
    expect(loadRdGatewayRecord(vault, 'gw')?.ownLogin).toEqual({ username: 'linked', password: 'linked-pw', domain: 'CORP' });
  });

  it('has no own login when the linked credential is gone', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: gwConfig, credential_id: 'gone', username: 'stale', password: 'stale' }),
    );
    expect(loadRdGatewayRecord(vault, 'gw')?.ownLogin).toBeNull();
  });

  it('has no own login when the link points at something that is not a credential', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: gwConfig, credential_id: 'pc' }),
      entry({ id: 'pc', entry_type: 'rdp', username: 'u', password: 'p' }),
    );
    expect(loadRdGatewayRecord(vault, 'gw')?.ownLogin).toBeNull();
  });

  it('skips the login lookup when the gateway uses the RDP entry login', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: { ...gwConfig, gatewayLoginSource: 'connection' }, credential_id: 'cred' }),
      entry({ id: 'cred', username: 'linked', password: 'linked-pw' }),
    );
    expect(loadRdGatewayRecord(vault, 'gw')?.ownLogin).toBeNull();
    expect(vault.getEntry).not.toHaveBeenCalledWith('cred');
  });

  it('returns null for a missing entry', () => {
    expect(loadRdGatewayRecord(vaultOf(), 'nope')).toBeNull();
  });

  it('treats an empty typed-in login as none', () => {
    const vault = vaultOf(entry({ id: 'gw', credential_type: 'rd_gateway', config: gwConfig }));
    expect(loadRdGatewayRecord(vault, 'gw')?.ownLogin).toBeNull();
  });
});

describe('findRdGatewayEntry', () => {
  it('finds a gateway entry and ignores other entries', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: gwConfig }),
      entry({ id: 'cred', username: 'u' }),
    );
    expect(findRdGatewayEntry(vault, 'gw')?.id).toBe('gw');
    expect(findRdGatewayEntry(vault, 'cred')).toBeNull();
    expect(findRdGatewayEntry(vault, 'missing')).toBeNull();
  });
});

describe('connectGateway', () => {
  it('connects directly without a gateway id', () => {
    const vault = vaultOf();
    expect(connectGateway(undefined, hostLogin, vault)).toBeUndefined();
    expect(vault.getEntry).not.toHaveBeenCalled();
  });

  it('builds the engine config from the gateway\'s own login', () => {
    const vault = vaultOf(
      entry({
        id: 'gw',
        credential_type: 'rd_gateway',
        config: { gatewayHostname: 'gw.corp.example', gatewayPort: 8443, gatewayTransport: 'http', gatewayBypassLocal: true },
        username: 'GW\\gwuser',
        password: 'gw-pw',
      }),
    );
    expect(connectGateway('gw', hostLogin, vault)).toEqual({
      hostname: 'gw.corp.example',
      port: 8443,
      username: 'gwuser',
      password: 'gw-pw',
      domain: 'GW',
      transport: 'http',
      bypassLocal: true,
    });
  });

  it('uses the RDP entry login when the gateway is set to', () => {
    const vault = vaultOf(
      entry({ id: 'gw', credential_type: 'rd_gateway', config: { ...gwConfig, gatewayLoginSource: 'connection' } }),
    );
    expect(connectGateway('gw', { username: 'CORP\\alice', password: 'host-pw', domain: null }, vault)).toMatchObject({
      username: 'alice',
      password: 'host-pw',
      domain: 'CORP',
    });
  });

  it('fails with a clear error when the gateway was deleted', () => {
    expect(() => connectGateway('gone', hostLogin, vaultOf())).toThrow(GatewayConfigError);
    expect(() => connectGateway('gone', hostLogin, vaultOf())).toThrow(/was deleted/);
  });

  it('fails when the id points at an entry that is not a gateway', () => {
    const vault = vaultOf(entry({ id: 'cred', username: 'u', password: 'p' }));
    expect(() => connectGateway('cred', hostLogin, vault)).toThrow(/was deleted/);
  });

  it('fails with a clear error when the linked login was deleted', () => {
    const vault = vaultOf(
      entry({ id: 'gw', name: 'Corp GW', credential_type: 'rd_gateway', config: gwConfig, credential_id: 'gone', username: 'stale' }),
    );
    expect(() => connectGateway('gw', hostLogin, vault)).toThrow('The gateway "Corp GW" has no login.');
  });
});

describe('parseGatewayIdArg', () => {
  it('accepts a missing or blank id as no gateway', () => {
    expect(parseGatewayIdArg(undefined)).toBeUndefined();
    expect(parseGatewayIdArg(null)).toBeUndefined();
    expect(parseGatewayIdArg('  ')).toBeUndefined();
  });

  it('trims an id', () => {
    expect(parseGatewayIdArg(' gw-1 ')).toBe('gw-1');
  });

  it('rejects anything else', () => {
    expect(() => parseGatewayIdArg({ hostname: 'gw' })).toThrow(GatewayConfigError);
    expect(() => parseGatewayIdArg(42)).toThrow(GatewayConfigError);
  });
});

describe('describeGateway', () => {
  it('never includes the password', () => {
    const line = describeGateway({
      hostname: 'gw',
      port: 443,
      username: 'u',
      password: 'top-secret',
      domain: '',
      transport: 'auto',
      bypassLocal: false,
    });
    expect(line).toBe('gateway=gw:443 transport=auto bypassLocal=false user=set');
    expect(line).not.toContain('top-secret');
  });
});
