// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { HlcClock, compareHlc, maxReceivable, ownStamps, startHlc, tick } from '../hlc.js';
import { emptyState } from '../state-view.js';
import { FUTURE_CAP_MS, HLC_MAX_COUNTER, type DevRecord, type Hlc, type SyncState } from '../types.js';

const WALL = 1_759_000_000_000;

function stateWith(vv: ReadonlyArray<readonly [number, number, number]>, devs: ReadonlyArray<readonly [number, string]> = []): SyncState {
  const base = emptyState('lineage', 'genesis', 0);
  return {
    ...base,
    vv: new Map(vv.map(([dev, ms, c]) => [dev, { ms, c }] as const)),
    devs: new Map(devs.map(([dev, deviceUuid]): [number, DevRecord] => [dev, { dev, deviceUuid, startedMs: 0 }])),
  };
}

describe('tick', () => {
  it('follows the wall clock when it is ahead', () => {
    expect(tick({ ms: WALL - 5, c: 9 }, WALL)).toEqual({ ms: WALL, c: 0 });
  });

  it('bumps the counter when the wall clock is equal or behind', () => {
    expect(tick({ ms: WALL, c: 3 }, WALL)).toEqual({ ms: WALL, c: 4 });
    expect(tick({ ms: WALL, c: 3 }, WALL - 1000)).toEqual({ ms: WALL, c: 4 });
  });

  it('moves to (ms + 1, 0) when the counter would pass 65535', () => {
    expect(tick({ ms: WALL, c: HLC_MAX_COUNTER }, WALL)).toEqual({ ms: WALL + 1, c: 0 });
    expect(tick({ ms: WALL, c: HLC_MAX_COUNTER }, WALL - 50)).toEqual({ ms: WALL + 1, c: 0 });
    expect(tick({ ms: WALL, c: HLC_MAX_COUNTER - 1 }, WALL)).toEqual({ ms: WALL, c: HLC_MAX_COUNTER });
  });

  it('floors fractional wall time and rejects non-finite values', () => {
    expect(tick({ ms: 0, c: 0 }, 10.9)).toEqual({ ms: 10, c: 0 });
    expect(() => tick({ ms: 0, c: 0 }, Number.NaN)).toThrow();
  });

  it('is strictly increasing for any wall clock sequence (property)', () => {
    fc.assert(
      fc.property(
        fc.record({ ms: fc.integer({ min: 0, max: 2 ** 45 }), c: fc.integer({ min: 0, max: HLC_MAX_COUNTER }) }),
        fc.array(fc.integer({ min: 0, max: 2 ** 45 }), { maxLength: 50 }),
        (start: Hlc, walls: number[]) => {
          let cur = start;
          for (const wall of walls) {
            const next = tick(cur, wall);
            expect(compareHlc(next, cur)).toBeGreaterThan(0);
            expect(next.ms).toBeGreaterThanOrEqual(wall);
            expect(next.c).toBeLessThanOrEqual(HLC_MAX_COUNTER);
            cur = next;
          }
        },
      ),
    );
  });
});

describe('startHlc and ownStamps', () => {
  it('starts at the max of the wall clock and own stamps, even future-dated ones', () => {
    expect(startHlc(WALL, [])).toEqual({ ms: WALL, c: 0 });
    expect(startHlc(WALL, [{ ms: WALL - 1, c: 99 }])).toEqual({ ms: WALL, c: 0 });
    expect(startHlc(WALL, [{ ms: WALL, c: 4 }, { ms: WALL, c: 2 }])).toEqual({ ms: WALL, c: 4 });
    expect(startHlc(WALL, [{ ms: WALL + 3 * FUTURE_CAP_MS, c: 1 }])).toEqual({ ms: WALL + 3 * FUTURE_CAP_MS, c: 1 });
  });

  it('collects vv entries of every dev this install minted, ordered by dev', () => {
    const s = stateWith(
      [[7, 50, 1], [3, 90, 0], [5, 10, 2]],
      [[7, 'me'], [3, 'me'], [5, 'other'], [9, 'me']],
    );
    expect(ownStamps(s, 'me')).toEqual([{ ms: 90, c: 0 }, { ms: 50, c: 1 }]);
    expect(ownStamps(s, 'nobody')).toEqual([]);
  });
});

describe('maxReceivable', () => {
  it('returns null for an empty vv', () => {
    expect(maxReceivable(stateWith([]), WALL, new Set())).toBeNull();
  });

  it('ignores other installs more than 24 h ahead but keeps own future stamps', () => {
    const s = stateWith([
      [1, WALL + FUTURE_CAP_MS + 1, 0],
      [2, WALL + FUTURE_CAP_MS, 3],
      [3, WALL - 10, 5],
    ]);
    expect(maxReceivable(s, WALL, new Set())).toEqual({ ms: WALL + FUTURE_CAP_MS, c: 3 });
    expect(maxReceivable(s, WALL, new Set([1]))).toEqual({ ms: WALL + FUTURE_CAP_MS + 1, c: 0 });
    expect(maxReceivable(stateWith([[1, WALL + FUTURE_CAP_MS + 1, 0]]), WALL, new Set())).toBeNull();
  });
});

describe('HlcClock', () => {
  it('ticks from the injected clock, absorbs received stamps and never goes back', () => {
    let now = WALL;
    const clock = new HlcClock(() => now, { ms: WALL - 100, c: 0 });
    expect(clock.tick()).toEqual({ ms: WALL, c: 0 });
    expect(clock.tick()).toEqual({ ms: WALL, c: 1 });
    clock.receive({ ms: WALL + 500, c: 7 });
    expect(clock.peek()).toEqual({ ms: WALL + 500, c: 7 });
    expect(clock.tick()).toEqual({ ms: WALL + 500, c: 8 });
    clock.receive({ ms: WALL, c: 0 });
    clock.receive(null);
    expect(clock.peek()).toEqual({ ms: WALL + 500, c: 8 });
    now = WALL + 1000;
    expect(clock.tick()).toEqual({ ms: WALL + 1000, c: 0 });
    now = WALL - 5000;
    expect(clock.tick()).toEqual({ ms: WALL + 1000, c: 1 });
  });

  it('does not alias the start stamp or received stamps', () => {
    const start = { ms: 5, c: 5 };
    const clock = new HlcClock(() => 0, start);
    const seen = { ms: 9, c: 9 };
    clock.receive(seen);
    expect(clock.peek()).not.toBe(seen);
    expect(clock.tick()).toEqual({ ms: 9, c: 10 });
    expect(start).toEqual({ ms: 5, c: 5 });
  });
});
