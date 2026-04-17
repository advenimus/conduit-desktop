/**
 * DNS resolution with fallback strategies.
 *
 * On some Windows corporate/domain-joined machines, Node.js dns.lookup()
 * (which uses getaddrinfo via libuv) can fail even when nslookup/ping
 * resolve the same hostname fine. This module tries multiple strategies:
 *
 *   1. dns.lookup()   — OS resolver (getaddrinfo), respects hosts file & search suffixes
 *   2. dns.resolve4() — c-ares direct UDP DNS queries, bypasses OS resolver
 */

import { isIP } from 'node:net';
import { lookup, resolve4 } from 'node:dns/promises';

/**
 * Resolve a hostname to an IP address, trying multiple strategies.
 * Returns the original hostname unchanged if it's already an IP or if all strategies fail.
 */
export async function resolveHostname(hostname: string): Promise<string> {
  if (!hostname || isIP(hostname)) {
    return hostname;
  }

  const startTime = Date.now();
  console.log(`[DNS] Resolving hostname: ${hostname} (platform=${process.platform})`);

  // Strategy 1: dns.lookup() — OS getaddrinfo
  try {
    const t0 = Date.now();
    const result = await lookup(hostname);
    console.log(`[DNS] Resolved ${hostname} → ${result.address} (via lookup, family=${result.family}, ${Date.now() - t0}ms)`);
    return result.address;
  } catch (lookupErr: unknown) {
    const err = lookupErr as NodeJS.ErrnoException;
    console.warn(`[DNS] dns.lookup() failed for ${hostname}: code=${err.code ?? 'unknown'}, syscall=${err.syscall ?? 'unknown'}, message=${err.message}`);
  }

  // Strategy 2: dns.resolve4() — c-ares direct DNS
  try {
    const t0 = Date.now();
    const addresses = await resolve4(hostname);
    if (addresses.length > 0) {
      console.log(`[DNS] Resolved ${hostname} → ${addresses[0]} (via resolve4, ${Date.now() - t0}ms, total=${Date.now() - startTime}ms)`);
      return addresses[0];
    }
    console.warn(`[DNS] dns.resolve4() returned empty results for ${hostname}`);
  } catch (resolveErr: unknown) {
    const err = resolveErr as NodeJS.ErrnoException;
    console.warn(`[DNS] dns.resolve4() failed for ${hostname}: code=${err.code ?? 'unknown'}, message=${err.message}`);
  }

  console.error(`[DNS] All resolution strategies failed for ${hostname} after ${Date.now() - startTime}ms, passing through as-is`);
  return hostname;
}
