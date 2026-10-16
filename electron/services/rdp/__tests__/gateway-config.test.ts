import { describe, it, expect } from 'vitest';
import {
  GatewayConfigError,
  RD_GATEWAY_CREDENTIAL_TYPE,
  describeGatewayAddress,
  gatewayIdOf,
  isRdGateway,
  normalizeGatewayHost,
  readGatewayConfig,
  resolveGatewayEngineConfig,
  splitDomainUser,
  type RdGatewayRecord,
} from '../gateway-config.js';

function gateway(overrides: Partial<RdGatewayRecord> = {}): RdGatewayRecord {
  return {
    id: 'gw-1',
    name: 'Corp gateway',
    entryType: 'credential',
    credentialType: RD_GATEWAY_CREDENTIAL_TYPE,
    config: { gatewayHostname: 'gw.corp.example' },
    ownLogin: { username: 'gwuser', password: 'gwpw', domain: 'CORP' },
    ...overrides,
  };
}

const host = { username: 'HOSTDOM\\alice', password: 'pw', domain: '' };

describe('normalizeGatewayHost', () => {
  it('keeps a plain host', () => {
    expect(normalizeGatewayHost('gw.corp.example')).toEqual({ hostname: 'gw.corp.example' });
  });

  it('strips a scheme, path and trailing slash', () => {
    expect(normalizeGatewayHost(' https://gw.corp.example/remoteDesktopGateway/ ')).toEqual({
      hostname: 'gw.corp.example',
    });
  });

  it('pulls out an embedded port', () => {
    expect(normalizeGatewayHost('gw.corp.example:8443')).toEqual({ hostname: 'gw.corp.example', port: 8443 });
  });

  it('returns an empty hostname for blank input', () => {
    expect(normalizeGatewayHost('   ')).toEqual({ hostname: '' });
  });
});

describe('splitDomainUser', () => {
  it('splits DOMAIN\\user', () => {
    expect(splitDomainUser('CORP\\alice', '')).toEqual({ username: 'alice', domain: 'CORP' });
  });

  it('keeps an explicit domain over a parsed one', () => {
    expect(splitDomainUser('CORP\\alice', 'OTHER')).toEqual({ username: 'CORP\\alice', domain: 'OTHER' });
  });

  it('leaves user@domain alone for NTLM to handle', () => {
    expect(splitDomainUser('alice@corp.example', '')).toEqual({ username: 'alice@corp.example', domain: '' });
  });
});

describe('isRdGateway / gatewayIdOf', () => {
  it('recognizes a gateway entry', () => {
    expect(isRdGateway({ entry_type: 'credential', credential_type: 'rd_gateway' })).toBe(true);
    expect(isRdGateway({ entry_type: 'credential', credential_type: 'generic' })).toBe(false);
    expect(isRdGateway({ entry_type: 'rdp', credential_type: 'rd_gateway' })).toBe(false);
  });

  it('reads a trimmed gateway id and ignores junk', () => {
    expect(gatewayIdOf({ gatewayId: ' gw-1 ' })).toBe('gw-1');
    expect(gatewayIdOf({ gatewayId: '' })).toBeUndefined();
    expect(gatewayIdOf({ gatewayId: 5 })).toBeUndefined();
    expect(gatewayIdOf(null)).toBeUndefined();
  });
});

describe('readGatewayConfig / describeGatewayAddress', () => {
  it('fills defaults', () => {
    expect(readGatewayConfig({})).toEqual({
      gatewayHostname: '',
      gatewayPort: 443,
      gatewayTransport: 'auto',
      gatewayBypassLocal: false,
      gatewayLoginSource: 'own',
    });
  });

  it('uses a port typed into the server box when there is no port field', () => {
    expect(readGatewayConfig({ gatewayHostname: 'gw:9443' }).gatewayPort).toBe(9443);
  });

  it('prefers the port field over a port in the server box', () => {
    expect(readGatewayConfig({ gatewayHostname: 'gw:9443', gatewayPort: 4443 }).gatewayPort).toBe(4443);
  });

  it('drops an out-of-range port and junk transport', () => {
    expect(readGatewayConfig({ gatewayHostname: 'gw', gatewayPort: 70000, gatewayTransport: 'udp' })).toMatchObject({
      gatewayPort: 443,
      gatewayTransport: 'auto',
    });
  });

  it('describes the address, leaving off 443', () => {
    expect(describeGatewayAddress({ gatewayHostname: 'gw' })).toBe('gw');
    expect(describeGatewayAddress({ gatewayHostname: 'gw', gatewayPort: 8443 })).toBe('gw:8443');
    expect(describeGatewayAddress({})).toBe('');
  });
});

describe('resolveGatewayEngineConfig', () => {
  it('uses the gateway\'s own login', () => {
    expect(resolveGatewayEngineConfig('gw-1', gateway(), host)).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      username: 'gwuser',
      password: 'gwpw',
      domain: 'CORP',
      transport: 'auto',
      bypassLocal: false,
    });
  });

  it('uses the RDP entry\'s login when set to', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayLoginSource: 'connection' }, ownLogin: null });
    expect(resolveGatewayEngineConfig('gw-1', gw, host)).toMatchObject({ username: 'alice', domain: 'HOSTDOM', password: 'pw' });
  });

  it('passes transport, port and bypass through', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayPort: 8443, gatewayTransport: 'http', gatewayBypassLocal: true } });
    expect(resolveGatewayEngineConfig('gw-1', gw, host)).toMatchObject({ port: 8443, transport: 'http', bypassLocal: true });
  });

  it('throws when the gateway entry is gone', () => {
    expect(() => resolveGatewayEngineConfig('gw-1', null, host)).toThrow(GatewayConfigError);
    expect(() => resolveGatewayEngineConfig('gw-1', null, host)).toThrow(/was deleted/);
  });

  it('throws when the id points at something that is not a gateway', () => {
    expect(() => resolveGatewayEngineConfig('gw-1', gateway({ credentialType: 'generic' }), host)).toThrow(/was deleted/);
  });

  it('throws when the gateway has no server address', () => {
    expect(() => resolveGatewayEngineConfig('gw-1', gateway({ config: {} }), host)).toThrow(/no server address/);
  });

  it('throws when the gateway has no login of its own', () => {
    expect(() => resolveGatewayEngineConfig('gw-1', gateway({ ownLogin: null }), host)).toThrow(/has no login/);
  });

  it('throws when it uses the entry login and the entry has none', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayLoginSource: 'connection' } });
    expect(() => resolveGatewayEngineConfig('gw-1', gw, { username: '', password: '' })).toThrow(/has no username/);
  });
});
