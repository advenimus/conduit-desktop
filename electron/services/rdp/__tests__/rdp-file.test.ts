import { describe, it, expect, vi } from 'vitest';
import { buildRdpFileText, rdpFileGatewayConfig } from '../rdp-file.js';
import type { GatewayVault, GatewayVaultEntry } from '../gateway-connect.js';

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

  it('asks for the gateway password when the gateway links a saved credential', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: 'gw.corp.example', gatewayLoginSource: 'credential', gatewayCredentialId: 'c1' },
    });
    expect(text).toContain('gatewaycredentialssource:i:0\r\n');
    expect(text).toContain('promptcredentialonce:i:0\r\n');
    expect(text).not.toContain('c1');
  });

  it('brackets an IPv6 gateway so its port stays separate', () => {
    const text = buildRdpFileText({
      host: 'pc01',
      port: 3389,
      config: {},
      gateway: { gatewayHostname: '2001:db8::1', gatewayPort: 8443 },
    });
    expect(text).toContain('gatewayhostname:s:[2001:db8::1]:8443\r\n');
  });
});

describe('rdpFileGatewayConfig', () => {
  const gw = (over: Partial<GatewayVaultEntry> = {}): GatewayVaultEntry => ({
    id: 'gw',
    name: 'Office',
    entry_type: 'credential',
    credential_type: 'rd_gateway',
    config: { gatewayHostname: 'gw.corp.example' },
    credential_id: null,
    ...over,
  });
  const vaultOf = (...entries: GatewayVaultEntry[]): GatewayVault => ({
    getEntry: (id) => {
      const e = entries.find((x) => x.id === id);
      if (!e) throw new Error(`Entry not found: ${id}`);
      return e;
    },
  });

  it('gives nothing for an entry without a gateway', () => {
    expect(rdpFileGatewayConfig(vaultOf(), {})).toBeNull();
  });

  it('gives the gateway config', () => {
    expect(rdpFileGatewayConfig(vaultOf(gw()), { gatewayId: 'gw' })).toEqual({ gatewayHostname: 'gw.corp.example' });
  });

  it('uses the shared message when the gateway was deleted', () => {
    expect(() => rdpFileGatewayConfig(vaultOf(), { gatewayId: 'gw' })).toThrow(
      "The gateway this entry uses was deleted. Pick a gateway again in the entry's Gateway settings.",
    );
  });

  it('uses the shared message when the gateway has no address', () => {
    expect(() => rdpFileGatewayConfig(vaultOf(gw({ config: {} })), { gatewayId: 'gw' })).toThrow(
      'The gateway "Office" has no server address.',
    );
  });

  it('throws a plain Error so the renderer shows only the message', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const locked: GatewayVault = {
      getEntry: () => {
        throw new Error('Vault is not unlocked');
      },
    };
    let caught: unknown;
    try {
      rdpFileGatewayConfig(locked, { gatewayId: 'gw' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('Error');
    expect((caught as Error).message).toBe('Could not read the gateway from the vault: Vault is not unlocked');
    errorLog.mockRestore();
  });
});
