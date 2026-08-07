import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import dgram from 'node:dgram';
import {
  isPrivateAddress,
  probeLocalNetwork,
  triggerLocalNetworkAlert,
  isLocalNetworkBlocked,
  annotateLocalNetworkError,
  withLocalNetworkHint,
  LOCAL_NETWORK_BLOCKED_TAG,
} from '../local-network.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.10.20',
    '100.64.0.1',
    '100.127.255.254',
  ])('treats %s as a gated local address', (host) => {
    expect(isPrivateAddress(host)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the RFC1918 block
    '172.32.0.1', // just above it
    '192.169.1.1',
    '100.63.255.255', // just below the CGNAT block
    '100.128.0.1', // just above it
  ])('treats %s as a public address', (host) => {
    expect(isPrivateAddress(host)).toBe(false);
  });

  it('does not gate loopback — macOS never blocks it', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(false);
  });

  it('rejects hostnames and IPv6 rather than guessing', () => {
    expect(isPrivateAddress('server.local')).toBe(false);
    expect(isPrivateAddress('fe80::1')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('non-macOS platforms', () => {
  it('reports granted without touching the network', async () => {
    setPlatform('win32');
    const spy = vi.spyOn(os, 'networkInterfaces');
    await expect(probeLocalNetwork()).resolves.toBe('granted');
    expect(spy).not.toHaveBeenCalled();
  });

  it('never reports a connection as blocked', async () => {
    setPlatform('linux');
    await expect(isLocalNetworkBlocked('192.168.1.10')).resolves.toBe(false);
  });

  it('triggers nothing', async () => {
    setPlatform('win32');
    const spy = vi.spyOn(os, 'networkInterfaces');
    await expect(triggerLocalNetworkAlert()).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

const LOOPBACK = {
  address: '127.0.0.1',
  netmask: '255.0.0.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal: true,
  cidr: '127.0.0.1/8',
};

const TUNNEL = {
  address: '100.115.236.78',
  netmask: '255.255.255.255',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '100.115.236.78/32',
};

// macOS masks hardware addresses for privacy, so a real Wi-Fi interface can
// report a placeholder MAC. The interface check must not read that as a tunnel.
const WIFI_WITH_MASKED_MAC = {
  address: '192.168.50.150',
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '02:00:00:00:00:00',
  internal: false,
  cidr: '192.168.50.150/24',
};

describe('probeLocalNetwork', () => {
  it('reports unavailable when only loopback and tunnels exist', async () => {
    setPlatform('darwin');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [LOOPBACK],
      utun4: [TUNNEL],
    });
    await expect(probeLocalNetwork()).resolves.toBe('unavailable');
  });

  it('still opens a socket when the LAN interface reports a masked MAC', async () => {
    setPlatform('darwin');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [LOOPBACK],
      en0: [WIFI_WITH_MASKED_MAC],
    });
    const createSocket = vi.spyOn(dgram, 'createSocket');

    // The status depends on the host's network; what matters is that the
    // interface check did not short-circuit before reaching the probe.
    await probeLocalNetwork();
    expect(createSocket).toHaveBeenCalled();
  });

  it('never opens a socket when there is nothing to probe', async () => {
    setPlatform('darwin');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ utun4: [TUNNEL] });
    const createSocket = vi.spyOn(dgram, 'createSocket');

    await probeLocalNetwork();
    expect(createSocket).not.toHaveBeenCalled();
  });
});

describe('error annotation', () => {
  it('leaves public-host failures alone', async () => {
    setPlatform('darwin');
    const message = 'connect EHOSTUNREACH 8.8.8.8:22';
    await expect(annotateLocalNetworkError(message, '8.8.8.8')).resolves.toBe(message);
  });

  it('returns the same Error instance when nothing was added', async () => {
    setPlatform('linux');
    const err = new Error('connect EHOSTUNREACH 192.168.1.10:22');
    await expect(withLocalNetworkHint(err, '192.168.1.10')).resolves.toBe(err);
  });

  it('exposes a tag the renderer can match on', () => {
    expect(LOCAL_NETWORK_BLOCKED_TAG).toBe('ConduitLocalNetworkBlocked');
  });
});
