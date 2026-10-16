import { describe, it, expect, vi } from 'vitest';
import {
  buildRdpEngineConfigFromEntry,
  resolutionToDimensions,
  mapQualityToPerformanceMode,
} from '../rdp-entry-config.js';
import { HARDCODED_GATEWAY_DEFAULTS, GatewayConfigError } from '../../services/rdp/gateway-config.js';

describe('mapQualityToPerformanceMode', () => {
  it('maps quality presets to engine performance modes', () => {
    expect(mapQualityToPerformanceMode('best')).toBe('best');
    expect(mapQualityToPerformanceMode('good')).toBe('balanced');
    expect(mapQualityToPerformanceMode('low')).toBe('fast');
  });

  it('defaults to balanced when unset', () => {
    expect(mapQualityToPerformanceMode(undefined)).toBe('balanced');
  });
});

describe('resolutionToDimensions', () => {
  it('parses a fixed WxH resolution', () => {
    expect(resolutionToDimensions({ resolution: '1280x720' })).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to 1920x1080 for match_window (no DOM headlessly)', () => {
    expect(resolutionToDimensions({ resolution: 'match_window' })).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to 1920x1080 when resolution is unset', () => {
    expect(resolutionToDimensions({})).toEqual({ width: 1920, height: 1080 });
  });

  it('uses custom dimensions when resolution is "custom"', () => {
    expect(resolutionToDimensions({ resolution: 'custom', customWidth: 2560, customHeight: 1440 })).toEqual({
      width: 2560,
      height: 1440,
    });
  });

  it('falls back when custom dimensions are missing', () => {
    expect(resolutionToDimensions({ resolution: 'custom' })).toEqual({ width: 1920, height: 1080 });
  });

  it('ignores a malformed resolution string', () => {
    expect(resolutionToDimensions({ resolution: 'banana' })).toEqual({ width: 1920, height: 1080 });
    expect(resolutionToDimensions({ resolution: 'x' })).toEqual({ width: 1920, height: 1080 });
  });
});

describe('buildRdpEngineConfigFromEntry', () => {
  const base = {
    host: 'server.example.com',
    port: 3389,
    username: 'admin',
    password: 'secret',
  };

  it('applies safe defaults when the entry has no stored RDP config', () => {
    const cfg = buildRdpEngineConfigFromEntry({ ...base, entryConfig: undefined });
    expect(cfg).toMatchObject({
      host: 'server.example.com',
      port: 3389,
      username: 'admin',
      password: 'secret',
      width: 1920,
      height: 1080,
      enableNla: true,
      skipCertVerification: true,
      performanceMode: 'balanced',
      enableClipboard: true,
      enableBitmapCache: true,
      enableServerPointer: true,
      frameRate: 30,
    });
    expect(cfg.sharedFolders).toBeUndefined();
  });

  it('honors stored entry settings', () => {
    const cfg = buildRdpEngineConfigFromEntry({
      ...base,
      domain: 'CORP',
      entryConfig: {
        resolution: '1440x900',
        colorDepth: 24,
        quality: 'best',
        clipboard: false,
        enableNla: false,
        hostname: 'alias.internal',
        sharedFolders: [{ name: 'Downloads', path: '/home/me/Downloads' }],
      },
    });
    expect(cfg).toMatchObject({
      domain: 'CORP',
      width: 1440,
      height: 900,
      colorDepth: 24,
      performanceMode: 'best',
      enableClipboard: false,
      enableNla: false,
      hostname: 'alias.internal',
    });
    expect(cfg.sharedFolders).toEqual([{ name: 'Downloads', path: '/home/me/Downloads' }]);
  });

  it('omits sharedFolders when the stored list is empty', () => {
    const cfg = buildRdpEngineConfigFromEntry({ ...base, entryConfig: { sharedFolders: [] } });
    expect(cfg.sharedFolders).toBeUndefined();
  });
});

describe('buildRdpEngineConfigFromEntry gateway', () => {
  const base = {
    host: 'pc01.corp.local',
    port: 3389,
    username: 'CORP\\alice',
    password: 'host-pw',
  };
  const enabledDefaults = {
    ...HARDCODED_GATEWAY_DEFAULTS,
    gatewayEnabled: true,
    gatewayHostname: 'gw.corp.example',
  };

  it('connects directly when no default gateway is on', () => {
    const cfg = buildRdpEngineConfigFromEntry({
      ...base,
      entryConfig: {},
      gatewayDefaults: HARDCODED_GATEWAY_DEFAULTS,
    });
    expect(cfg.gateway).toBeUndefined();
  });

  it('connects directly when no defaults are passed', () => {
    expect(buildRdpEngineConfigFromEntry({ ...base, entryConfig: {} }).gateway).toBeUndefined();
  });

  it('uses the enabled default gateway with the host login', () => {
    const cfg = buildRdpEngineConfigFromEntry({ ...base, entryConfig: {}, gatewayDefaults: enabledDefaults });
    expect(cfg.gateway).toEqual({
      hostname: 'gw.corp.example',
      port: 443,
      username: 'alice',
      password: 'host-pw',
      domain: 'CORP',
      transport: 'auto',
      bypassLocal: false,
    });
  });

  it('skips the default gateway when the entry turns it off', () => {
    const cfg = buildRdpEngineConfigFromEntry({
      ...base,
      entryConfig: { gatewayMode: 'off' },
      gatewayDefaults: enabledDefaults,
    });
    expect(cfg.gateway).toBeUndefined();
  });

  it('uses a custom gateway from the entry', () => {
    const cfg = buildRdpEngineConfigFromEntry({
      ...base,
      domain: 'CORP',
      username: 'alice',
      entryConfig: {
        gatewayMode: 'custom',
        gatewayHostname: 'rdg.other.example',
        gatewayPort: 8443,
        gatewayTransport: 'http',
        gatewayBypassLocal: true,
      },
    });
    expect(cfg.gateway).toEqual({
      hostname: 'rdg.other.example',
      port: 8443,
      username: 'alice',
      password: 'host-pw',
      domain: 'CORP',
      transport: 'http',
      bypassLocal: true,
    });
  });

  it('uses the linked vault credential for the gateway login', () => {
    const lookupCredential = vi.fn(() => ({ username: 'gwuser', password: 'gw-pw', domain: 'GW' }));
    const cfg = buildRdpEngineConfigFromEntry({
      ...base,
      entryConfig: { gatewayCredentialMode: 'credential', gatewayCredentialId: 'cred-9' },
      gatewayDefaults: enabledDefaults,
      lookupCredential,
    });
    expect(lookupCredential).toHaveBeenCalledWith('cred-9');
    expect(cfg.gateway).toMatchObject({ username: 'gwuser', password: 'gw-pw', domain: 'GW' });
    expect(cfg.username).toBe('CORP\\alice');
  });

  it('fails with a clear error when the linked credential is missing', () => {
    expect(() =>
      buildRdpEngineConfigFromEntry({
        ...base,
        entryConfig: { gatewayCredentialMode: 'credential', gatewayCredentialId: 'gone' },
        gatewayDefaults: enabledDefaults,
        lookupCredential: () => {
          throw new Error('Credential not found: gone');
        },
      }),
    ).toThrow(GatewayConfigError);
  });
});
