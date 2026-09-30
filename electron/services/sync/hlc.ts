/**
 * Hybrid logical clock of spec 4.1: tick, receive (with the 24 h future cap for other
 * installs), start from own past stamps. Dot, rank, vv and pmem primitives are implemented in
 * sibling.ts and re-exported here so callers can import clock things from one place.
 * Golden vectors: __vectors__/hlc.json.
 */

import { compareHlc } from './sibling.js';
import { FUTURE_CAP_MS, HLC_MAX_COUNTER } from './types.js';
import type { Dev, Hlc, SyncState } from './types.js';

export {
  compareHlc,
  compareIdentity,
  compareRank,
  identityKey,
  pmemCovers,
  pmemJoin,
  vvCovers,
  vvDominates,
  vvJoin,
} from './sibling.js';

function requireWall(wallMs: number): number {
  if (!Number.isFinite(wallMs)) throw new Error('hlc: wall clock is not a finite number');
  return Math.floor(wallMs);
}

/** Tick: ms' = max(wall, ms); c' = ms' == ms ? c + 1 : 0; counter overflow moves to (ms + 1, 0). */
export function tick(prev: Hlc, wallMs: number): Hlc {
  const wall = requireWall(wallMs);
  if (wall > prev.ms) return { ms: wall, c: 0 };
  const c = prev.c + 1;
  return c > HLC_MAX_COUNTER ? { ms: prev.ms + 1, c: 0 } : { ms: prev.ms, c };
}

function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** Start: max(wall, every own stamp) as (ms, c); own stamps may be future-dated. */
export function startHlc(wallMs: number, ownStamps: readonly Hlc[]): Hlc {
  let best: Hlc = { ms: requireWall(wallMs), c: 0 };
  for (const stamp of ownStamps) best = maxHlc(best, stamp);
  return { ms: best.ms, c: best.c };
}

/** vv entries of every dev that sync_dev maps to `deviceUuid` (this install's own past dots), by dev. */
export function ownStamps(state: SyncState, deviceUuid: string): Hlc[] {
  const devs = [...state.devs.values()]
    .filter((rec) => rec.deviceUuid === deviceUuid)
    .map((rec) => rec.dev)
    .sort((a, b) => a - b);
  const out: Hlc[] = [];
  for (const dev of devs) {
    const stamp = state.vv.get(dev);
    if (stamp !== undefined) out.push(stamp);
  }
  return out;
}

/**
 * The stamp receive() should absorb after a merge: max vv entry, ignoring entries of other
 * installs (dev not in ownDevs) whose ms > wallMs + FUTURE_CAP_MS. Null when vv is empty.
 */
export function maxReceivable(state: SyncState, wallMs: number, ownDevs: ReadonlySet<Dev>): Hlc | null {
  const cap = requireWall(wallMs) + FUTURE_CAP_MS;
  let best: Hlc | null = null;
  for (const [dev, stamp] of state.vv) {
    if (stamp.ms > cap && !ownDevs.has(dev)) continue;
    best = best === null ? stamp : maxHlc(best, stamp);
  }
  return best === null ? null : { ms: best.ms, c: best.c };
}

/** The per-process clock. Stamps are never rewritten; tick() is strictly increasing. */
export class HlcClock {
  private readonly now: () => number;
  private current: Hlc;

  constructor(now: () => number, start: Hlc) {
    this.now = now;
    this.current = { ms: start.ms, c: start.c };
  }

  /** Next stamp for a new app dot. */
  tick(): Hlc {
    this.current = tick(this.current, this.now());
    return this.current;
  }

  /** hlc = max(hlc, seen). A null `seen` is a no-op. */
  receive(seen: Hlc | null): void {
    if (seen !== null && compareHlc(seen, this.current) > 0) this.current = { ms: seen.ms, c: seen.c };
  }

  /** Current stamp without ticking. */
  peek(): Hlc {
    return this.current;
  }
}
