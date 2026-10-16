import { describe, it, expect } from 'vitest';
import {
  HARDCODED_GATEWAY_DEFAULTS,
  GatewayConfigError,
  normalizeGatewayHost,
  resolveGatewaySettings,
  resolveGatewayEngineConfig,
  splitDomainUser,
  type RdpGatewayDefaults,
} from '../gateway-config.js';

const enabledDefaults: RdpGatewayDefaults = {
  ...HARDCODED_GATEWAY_DEFAULTS,
  gatewayEnabled: true,
  gatewayHostname: 'gw.corp.example',
};

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

describe('resolveGatewaySettings', () => {
  it('is off when the entry has no gateway and no default is enabled', () => {
    expect(resolveGatewaySettings({}, HARDCODED_GATEWAY_DEFAULTS)).toBeNull();
  });

  it('uses the enabled default when the entry mode is unset', () => {
    expect(resolveGatewaySettings({}, enabledDefaults)).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      transport: 'auto',
      bypassLocal: false,
      credentialMode: 'same',
      credentialId: undefined,
      source: 'default',
    });
  });

  it('ignores an enabled default whose hostname is blank', () => {
    expect(resolveGatewaySettings({}, { ...enabledDefaults, gatewayHostname: ' ' })).toBeNull();
  });

  it('turns the gateway off for mode off even with a default', () => {
    expect(resolveGatewaySettings({ gatewayMode: 'off' }, enabledDefaults)).toBeNull();
  });

  it('uses the entry values in custom mode', () => {
    expect(
      resolveGatewaySettings(
        {
          gatewayMode: 'custom',
          gatewayHostname: 'other-gw:9443',
          gatewayTransport: 'http',
          gatewayBypassLocal: true,
          gatewayCredentialMode: 'credential',
          gatewayCredentialId: 'cred-1',
        },
        enabledDefaults,
      ),
    ).toEqual({
      hostname: 'other-gw',
      port: 9443,
      transport: 'http',
      bypassLocal: true,
      credentialMode: 'credential',
      credentialId: 'cred-1',
      source: 'entry',
    });
  });

  it('prefers the explicit port over a port in the hostname', () => {
    const s = resolveGatewaySettings(
      { gatewayMode: 'custom', gatewayHostname: 'gw:9443', gatewayPort: 4443 },
      HARDCODED_GATEWAY_DEFAULTS,
    );
    expect(s?.port).toBe(4443);
  });

  it('falls back to 443 for an out-of-range port', () => {
    const s = resolveGatewaySettings(
      { gatewayMode: 'custom', gatewayHostname: 'gw', gatewayPort: 70000 },
      HARDCODED_GATEWAY_DEFAULTS,
    );
    expect(s?.port).toBe(443);
  });

  it('is off in custom mode with no hostname', () => {
    expect(resolveGatewaySettings({ gatewayMode: 'custom', gatewayHostname: '' }, enabledDefaults)).toBeNull();
  });

  it('lets a default-mode entry pick its own gateway login', () => {
    const s = resolveGatewaySettings(
      { gatewayCredentialMode: 'credential', gatewayCredentialId: 'cred-9' },
      enabledDefaults,
    );
    expect(s).toMatchObject({ source: 'default', credentialMode: 'credential', credentialId: 'cred-9' });
  });

  it('treats credential mode with no id as same-login', () => {
    const s = resolveGatewaySettings({ gatewayCredentialMode: 'credential' }, enabledDefaults);
    expect(s?.credentialMode).toBe('same');
  });

  it('tolerates junk values from an older or foreign client', () => {
    const s = resolveGatewaySettings(
      { gatewayMode: 'weird' as never, gatewayTransport: 'udp' as never },
      enabledDefaults,
    );
    expect(s).toMatchObject({ source: 'default', transport: 'auto' });
  });
});

describe('resolveGatewayEngineConfig', () => {
  const settings = resolveGatewaySettings({}, enabledDefaults)!;
  const host = { username: 'CORP\\alice', password: 'pw', domain: '' };

  it('reuses the host login in same mode', () => {
    expect(resolveGatewayEngineConfig(settings, host, null)).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      username: 'alice',
      password: 'pw',
      domain: 'CORP',
      transport: 'auto',
      bypassLocal: false,
    });
  });

  it('uses the linked credential in credential mode', () => {
    const s = { ...settings, credentialMode: 'credential' as const, credentialId: 'cred-1' };
    const gw = resolveGatewayEngineConfig(s, host, { username: 'gwuser', password: 'gwpw', domain: 'GW' });
    expect(gw).toMatchObject({ username: 'gwuser', password: 'gwpw', domain: 'GW' });
  });

  it('throws a clear error when the linked credential is missing', () => {
    const s = { ...settings, credentialMode: 'credential' as const, credentialId: 'gone' };
    expect(() => resolveGatewayEngineConfig(s, host, null)).toThrow(GatewayConfigError);
    expect(() => resolveGatewayEngineConfig(s, host, null)).toThrow(/saved gateway login/i);
  });

  it('throws a clear error when same mode has no host username', () => {
    expect(() => resolveGatewayEngineConfig(settings, { username: '', password: '' }, null)).toThrow(
      /gateway needs a login/i,
    );
  });
});
