import { describe, it, expect, vi } from 'vitest';
import { GatewayConfigError, HARDCODED_GATEWAY_DEFAULTS, type RdpGatewaySettings } from '../gateway-config.js';
import {
  connectGateway,
  describeGateway,
  gatewayDefaultsFrom,
  parseGatewaySettingsArg,
} from '../gateway-connect.js';

const settings: RdpGatewaySettings = {
  hostname: 'gw.corp.example',
  port: 443,
  transport: 'auto',
  bypassLocal: false,
  credentialMode: 'same',
  source: 'entry',
};

const hostLogin = { username: 'CORP\\alice', password: 'host-pw', domain: '' };

describe('gatewayDefaultsFrom', () => {
  it('fills every default for an old settings value without gateway keys', () => {
    expect(gatewayDefaultsFrom({ resolution: 'match_window' })).toEqual(HARDCODED_GATEWAY_DEFAULTS);
  });

  it('falls back to defaults for non-objects', () => {
    expect(gatewayDefaultsFrom(undefined)).toEqual(HARDCODED_GATEWAY_DEFAULTS);
    expect(gatewayDefaultsFrom('nope')).toEqual(HARDCODED_GATEWAY_DEFAULTS);
  });

  it('keeps stored values and drops ones with the wrong type', () => {
    expect(
      gatewayDefaultsFrom({
        gatewayEnabled: true,
        gatewayHostname: 'gw.corp.example',
        gatewayPort: '8443',
        gatewayTransport: 'http',
        gatewayBypassLocal: true,
      }),
    ).toEqual({
      gatewayEnabled: true,
      gatewayHostname: 'gw.corp.example',
      gatewayPort: 443,
      gatewayTransport: 'http',
      gatewayBypassLocal: true,
    });
  });
});

describe('parseGatewaySettingsArg', () => {
  it('returns null when no gateway was sent', () => {
    expect(parseGatewaySettingsArg(undefined)).toBeNull();
    expect(parseGatewaySettingsArg(null)).toBeNull();
  });

  it('accepts well-formed settings', () => {
    expect(parseGatewaySettingsArg({ ...settings, port: 8443, transport: 'rpc', bypassLocal: true })).toEqual({
      ...settings,
      port: 8443,
      transport: 'rpc',
      bypassLocal: true,
      credentialId: undefined,
    });
  });

  it('cleans bad port, transport and credential values', () => {
    expect(
      parseGatewaySettingsArg({
        hostname: 'https://gw.corp.example/',
        port: 99999,
        transport: 'carrier-pigeon',
        bypassLocal: 'yes',
        credentialMode: 'credential',
        source: 'elsewhere',
      }),
    ).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      transport: 'auto',
      bypassLocal: false,
      credentialMode: 'same',
      credentialId: undefined,
      source: 'entry',
    });
  });

  it('rejects a missing gateway address', () => {
    expect(() => parseGatewaySettingsArg({ ...settings, hostname: '  ' })).toThrow(GatewayConfigError);
  });

  it('rejects a value that is not an object', () => {
    expect(() => parseGatewaySettingsArg('gw.corp.example')).toThrow(GatewayConfigError);
  });
});

describe('connectGateway', () => {
  it('returns undefined when there is no gateway', () => {
    expect(connectGateway(null, hostLogin, () => null)).toBeUndefined();
  });

  it('uses the host login in same mode and never looks up a credential', () => {
    const lookup = vi.fn();
    expect(connectGateway(settings, hostLogin, lookup)).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      username: 'alice',
      password: 'host-pw',
      domain: 'CORP',
      transport: 'auto',
      bypassLocal: false,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses the linked vault credential in credential mode', () => {
    const lookup = vi.fn(() => ({ username: 'gwuser', password: 'gw-pw', domain: 'GW' }));
    const cfg = connectGateway({ ...settings, credentialMode: 'credential', credentialId: 'cred-1' }, hostLogin, lookup);
    expect(lookup).toHaveBeenCalledWith('cred-1');
    expect(cfg).toMatchObject({ username: 'gwuser', password: 'gw-pw', domain: 'GW' });
  });

  it('treats null secrets on the linked credential as empty', () => {
    const cfg = connectGateway(
      { ...settings, credentialMode: 'credential', credentialId: 'cred-1' },
      hostLogin,
      () => ({ username: 'gwuser', password: null, domain: null }),
    );
    expect(cfg).toMatchObject({ username: 'gwuser', password: '', domain: '' });
  });

  it('throws a clear error when the linked credential is gone', () => {
    const lookup = () => {
      throw new Error('Credential not found: cred-1');
    };
    expect(() =>
      connectGateway({ ...settings, credentialMode: 'credential', credentialId: 'cred-1' }, hostLogin, lookup),
    ).toThrow(/saved gateway login/);
  });

  it('throws when same mode has no host username', () => {
    expect(() => connectGateway(settings, { username: '', password: '' }, () => null)).toThrow(GatewayConfigError);
  });
});

describe('describeGateway', () => {
  it('names host, port and transport but never the password', () => {
    const line = describeGateway({
      hostname: 'gw.corp.example',
      port: 8443,
      username: 'alice',
      password: 'super-secret',
      domain: 'CORP',
      transport: 'http',
      bypassLocal: true,
    });
    expect(line).toContain('gw.corp.example:8443');
    expect(line).toContain('transport=http');
    expect(line).not.toContain('super-secret');
  });
});
