import { describe, it, expect } from 'vitest';
import { buildRdpFileText } from '../rdp-file.js';

describe('buildRdpFileText', () => {
  it('writes the basic lines with CRLF endings and no gateway', () => {
    const text = buildRdpFileText({ host: 'pc01', port: 3389, config: {} });
    expect(text).toBe('full address:s:pc01:3389\r\nprompt for credentials:i:1\r\nscreen mode id:i:1\r\n');
    expect(text).not.toContain('gateway');
  });

  it('keeps color depth, sound and clipboard', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3390,
      config: { colorDepth: 24, sound: 'none', clipboard: false },
    });
    expect(text).toContain('session bpp:i:24\r\n');
    expect(text).toContain('audiomode:i:2\r\n');
    expect(text).toContain('redirectclipboard:i:0\r\n');
  });

  it('ignores the old per-entry gateway keys', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: { gatewayMode: 'custom', gatewayHostname: 'gw.corp.example' },
    });
    expect(text).not.toContain('gateway');
  });

  it('writes the gateway object on the default port without a port suffix', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: 'gw.corp.example' },
    });
    expect(text).toContain('gatewayhostname:s:gw.corp.example\r\n');
    expect(text).toContain('gatewayusagemethod:i:1\r\n');
    expect(text).toContain('gatewaycredentialssource:i:0\r\n');
    expect(text).toContain('gatewayprofileusagemethod:i:1\r\n');
    expect(text).toContain('promptcredentialonce:i:0\r\n');
  });

  it('adds a non-default port and uses bypass for local addresses', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: 'gw.corp.example', gatewayPort: 8443, gatewayBypassLocal: true },
    });
    expect(text).toContain('gatewayhostname:s:gw.corp.example:8443\r\n');
    expect(text).toContain('gatewayusagemethod:i:2\r\n');
  });

  it('asks for one login when the gateway uses the RDP entry login', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: 'gw.corp.example', gatewayLoginSource: 'connection' },
    });
    expect(text).toContain('promptcredentialonce:i:1\r\n');
  });

  it('writes no gateway when the gateway has no address', () => {
    const text = buildRdpFileText({ host: 'pc01', port: 3389, config: {}, gateway: { gatewayHostname: '' } });
    expect(text).not.toContain('gateway');
  });

  it('strips line breaks so a value cannot add lines to the file', () => {
    const text = buildRdpFileText({
      host: 'pc01\r\nalternate shell:s:evil',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: 'gw\nfoo:s:bar' },
    });
    expect(text.split('\r\n').some((l) => l.startsWith('alternate shell'))).toBe(false);
    expect(text.split('\r\n').some((l) => l.startsWith('foo:'))).toBe(false);
  });
});
