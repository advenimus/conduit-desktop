/**
 * Process-lifetime incarnation registry (spec 3.1, 4.1): the first open of a lineage in this
 * launch mints its incarnation and dev; later opens in the same launch reuse them (and the
 * high-water mark), so lock and unlock do not grow the version vector. Import through replica.ts.
 */

import { deriveDev } from './hashing.js';
import { HighWater, newIncarnation } from './identity.js';
import type { Random } from './host.js';
import type { LineageIncarnation } from './replica-types.js';

function entryKey(lineageId: string, deviceUuid: string): string {
  return `${lineageId}\u001f${deviceUuid}`;
}

function mint(lineageId: string, deviceUuid: string, random: Pick<Random, 'bytes'>): LineageIncarnation {
  const incarnation = newIncarnation((n) => random.bytes(n));
  return { incarnation, dev: deriveDev(deviceUuid, lineageId, incarnation), highWater: new HighWater() };
}

/**
 * Process-lifetime registry (created once at app start): the first open of a lineage in this
 * launch mints its incarnation; later opens in the same launch reuse it; renew() mints a new one
 * (high-water failure or dev collision). Memory only.
 */
export class IncarnationRegistry {
  private readonly entries = new Map<string, LineageIncarnation>();

  forLineage(lineageId: string, deviceUuid: string, random: Pick<Random, 'bytes'>): LineageIncarnation {
    const key = entryKey(lineageId, deviceUuid);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const fresh = mint(lineageId, deviceUuid, random);
    this.entries.set(key, fresh);
    return fresh;
  }

  renew(lineageId: string, deviceUuid: string, random: Pick<Random, 'bytes'>): LineageIncarnation {
    const previous = this.entries.get(entryKey(lineageId, deviceUuid));
    let fresh = mint(lineageId, deviceUuid, random);
    // A 2^-48 dev repeat would reuse dots; mint again rather than risk it.
    while (previous !== undefined && fresh.dev === previous.dev) fresh = mint(lineageId, deviceUuid, random);
    this.entries.set(entryKey(lineageId, deviceUuid), fresh);
    return fresh;
  }
}
