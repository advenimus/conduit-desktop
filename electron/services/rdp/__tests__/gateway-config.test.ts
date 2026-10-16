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
  validPort,
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

  it('takes a bracketed IPv6 address with a port apart, leaving the bare address for FreeRDP', () => {
    expect(normalizeGatewayHost('[2001:db8::1]:8443')).toEqual({ hostname: '2001:db8::1', port: 8443 });
    expect(normalizeGatewayHost('https://[2001:db8::1]:8443/remoteDesktopGateway/')).toEqual({
      hostname: '2001:db8::1',
      port: 8443,
    });
  });

  it('unwraps a bracketed IPv6 address without a port', () => {
    expect(normalizeGatewayHost('[2001:db8::1]')).toEqual({ hostname: '2001:db8::1' });
  });

  it('keeps a bare IPv6 address whole instead of reading its last group as a port', () => {
    expect(normalizeGatewayHost('2001:db8::1')).toEqual({ hostname: '2001:db8::1' });
    expect(normalizeGatewayHost('fe80::1:443')).toEqual({ hostname: 'fe80::1:443' });
  });

  it('drops a bad port after a bracketed IPv6 address', () => {
    expect(normalizeGatewayHost('[2001:db8::1]:99999')).toEqual({ hostname: '2001:db8::1' });
  });
});

describe('validPort', () => {
  it('accepts whole numbers from 1 to 65535 only', () => {
    expect(validPort(443)).toBe(443);
    expect(validPort(65535)).toBe(65535);
    expect(validPort(0)).toBeUndefined();
    expect(validPort(65536)).toBeUndefined();
    expect(validPort(44.3)).toBeUndefined();
    expect(validPort('443')).toBeUndefined();
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

  it('brackets an IPv6 address so a port can follow it', () => {
    expect(describeGatewayAddress({ gatewayHostname: '2001:db8::1', gatewayPort: 8443 })).toBe('[2001:db8::1]:8443');
    expect(describeGatewayAddress({ gatewayHostname: '[2001:db8::1]' })).toBe('[2001:db8::1]');
  });

  it('reads a linked credential from the config', () => {
    expect(readGatewayConfig({ gatewayLoginSource: 'credential', gatewayCredentialId: ' cred-1 ' })).toMatchObject({
      gatewayLoginSource: 'credential',
      gatewayCredentialId: 'cred-1',
    });
  });

  it('keeps the credential source when the linked id is missing, so connecting can say there is no login', () => {
    const g = readGatewayConfig({ gatewayLoginSource: 'credential' });
    expect(g.gatewayLoginSource).toBe('credential');
    expect(g.gatewayCredentialId).toBeUndefined();
  });

  it('reads an older gateway that linked its credential in the credential_id column', () => {
    expect(readGatewayConfig({ gatewayHostname: 'gw' }, 'cred-old')).toMatchObject({
      gatewayLoginSource: 'credential',
      gatewayCredentialId: 'cred-old',
    });
    expect(readGatewayConfig({ gatewayLoginSource: 'own' }, 'cred-old')).toMatchObject({
      gatewayLoginSource: 'credential',
      gatewayCredentialId: 'cred-old',
    });
  });

  it('prefers the config link and the connection login over the old column', () => {
    expect(readGatewayConfig({ gatewayLoginSource: 'credential', gatewayCredentialId: 'new' }, 'old').gatewayCredentialId).toBe('new');
    expect(readGatewayConfig({ gatewayLoginSource: 'connection' }, 'old')).toMatchObject({
      gatewayLoginSource: 'connection',
      gatewayCredentialId: undefined,
    });
  });

  it('ignores a stray linked id when the gateway uses the RDP entry login', () => {
    expect(readGatewayConfig({ gatewayLoginSource: 'connection', gatewayCredentialId: 'c' }).gatewayCredentialId).toBeUndefined();
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

  it('uses the linked credential\'s login', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayLoginSource: 'credential', gatewayCredentialId: 'c' } });
    expect(resolveGatewayEngineConfig('gw-1', gw, host)).toMatchObject({ username: 'gwuser', password: 'gwpw' });
  });

  it('throws the no-login error when the linked credential is gone', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayLoginSource: 'credential', gatewayCredentialId: 'c' }, ownLogin: null });
    expect(() => resolveGatewayEngineConfig('gw-1', gw, host)).toThrow(/has no login/);
  });

  it('throws when the gateway has no login of its own', () => {
    expect(() => resolveGatewayEngineConfig('gw-1', gateway({ ownLogin: null }), host)).toThrow(/has no login/);
  });

  it('throws when it uses the entry login and the entry has none', () => {
    const gw = gateway({ config: { gatewayHostname: 'gw', gatewayLoginSource: 'connection' } });
    expect(() => resolveGatewayEngineConfig('gw-1', gw, { username: '', password: '' })).toThrow(/has no username/);
  });
});
