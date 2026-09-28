// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  compareIdentity,
  compareRank,
  identityKey,
  isEligible,
  makePmem,
  pickIdentityCopy,
  pmemCovers,
  pmemJoin,
  vvCovers,
  vvDominates,
  vvJoin,
} from '../sibling.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, ZERO_VHASH, type Sibling } from '../types.js';

const hex = (n: number): string => n.toString(16).padStart(32, '0');

function app(dev: number, ms: number, c: number, extra: Partial<Sibling> = {}): Sibling {
  return { dev, ms, c, pid: '', lt: 0, vhash: hex(1), flags: 0, value: 'v', prevVhash: null, ...extra };
}

function pseudo(ms: number, pidN: number, lt = 0, extra: Partial<Sibling> = {}): Sibling {
  return { dev: 0, ms, c: 0, pid: hex(pidN), lt, vhash: hex(2), flags: 0, value: 'p', prevVhash: null, ...extra };
}

describe('identity and rank', () => {
  it('uses spec 4.5 identities', () => {
    expect(identityKey(app(7, 10, 2))).toBe('a:7:10:2');
    expect(identityKey(pseudo(5, 9))).toBe(`p:5:${hex(9)}`);
  });

  it('ranks by (ms, c, dev, lt, pid)', () => {
    expect(compareRank(app(1, 10, 0), app(2, 9, 5))).toBeGreaterThan(0);
    expect(compareRank(app(1, 10, 1), app(2, 10, 0))).toBeGreaterThan(0);
    expect(compareRank(app(3, 10, 0), app(2, 10, 0))).toBeGreaterThan(0);
    expect(compareRank(pseudo(0, 1, 50), pseudo(0, 9, 10))).toBeGreaterThan(0);
    expect(compareRank(pseudo(0, 9, 10), pseudo(0, 1, 10))).toBeGreaterThan(0);
    expect(compareRank(app(1, 5, 0), pseudo(5, 1, 99))).toBeGreaterThan(0);
  });

  it('orders storage by (dev, ms, c, pid)', () => {
    const sorted = [app(2, 1, 0), pseudo(9, 1), app(1, 5, 0)].sort(compareIdentity);
    expect(sorted.map(identityKey)).toEqual([`p:9:${hex(1)}`, 'a:1:5:0', 'a:2:1:0']);
  });

  it('treats undecryptable and redacted siblings as ineligible', () => {
    expect(isEligible(app(1, 1, 0))).toBe(true);
    expect(isEligible(app(1, 1, 0, { flags: SIB_UNDECRYPTABLE }))).toBe(false);
    expect(isEligible(app(1, 1, 0, { flags: SIB_REDACTED }))).toBe(false);
  });
});

describe('coverage', () => {
  it('covers app dots through the version vector', () => {
    const vv = new Map([[1, { ms: 10, c: 2 }]]);
    expect(vvCovers(vv, 1, { ms: 10, c: 2 })).toBe(true);
    expect(vvCovers(vv, 1, { ms: 10, c: 3 })).toBe(false);
    expect(vvCovers(vv, 2, { ms: 0, c: 0 })).toBe(false);
  });

  it('covers pseudo siblings through pmem', () => {
    const pm = makePmem(5, [hex(3), hex(1)]);
    expect(pm.ids).toEqual([hex(1), hex(3)]);
    expect(pmemCovers(pm, pseudo(4, 99))).toBe(true);
    expect(pmemCovers(pm, pseudo(5, 3))).toBe(true);
    expect(pmemCovers(pm, pseudo(5, 4))).toBe(false);
    expect(pmemCovers(pm, pseudo(6, 3))).toBe(false);
    expect(pmemCovers(null, pseudo(0, 0))).toBe(false);
  });

  it('joins pmem: larger ms wins, equal ms unions', () => {
    expect(pmemJoin(makePmem(1, [hex(1)]), makePmem(2, [hex(2)]))).toEqual(makePmem(2, [hex(2)]));
    expect(pmemJoin(makePmem(2, [hex(2)]), makePmem(2, [hex(1)]))).toEqual(makePmem(2, [hex(1), hex(2)]));
    expect(pmemJoin(null, makePmem(0, [hex(0)]))).toEqual(makePmem(0, [hex(0)]));
  });

  it('joins version vectors pointwise', () => {
    const a = new Map([[1, { ms: 5, c: 0 }], [2, { ms: 1, c: 0 }]]);
    const b = new Map([[1, { ms: 4, c: 9 }], [3, { ms: 7, c: 1 }]]);
    const j = vvJoin(a, b);
    expect([...j].sort((x, y) => x[0] - y[0])).toEqual([[1, { ms: 5, c: 0 }], [2, { ms: 1, c: 0 }], [3, { ms: 7, c: 1 }]]);
    expect(vvDominates(j, a) && vvDominates(j, b)).toBe(true);
    expect(vvDominates(a, b)).toBe(false);
  });
});

describe('pickIdentityCopy', () => {
  const copyArb = fc.record({
    flags: fc.constantFrom(0, SIB_UNDECRYPTABLE, SIB_REDACTED),
    vhash: fc.constantFrom(hex(1), hex(2)),
    value: fc.oneof(fc.constant(null), fc.integer(), fc.string(), fc.uint8Array({ maxLength: 4 })),
    prevVhash: fc.constantFrom(null, 'a'.repeat(16), 'b'.repeat(16)),
  });

  it('prefers redacted, then decryptable copies', () => {
    const plain = app(1, 1, 0);
    const redacted = app(1, 1, 0, { flags: SIB_REDACTED, value: null, vhash: ZERO_VHASH });
    const undec = app(1, 1, 0, { flags: SIB_UNDECRYPTABLE });
    expect(pickIdentityCopy(plain, redacted)).toBe(redacted);
    expect(pickIdentityCopy(undec, plain)).toBe(plain);
  });

  it('is commutative and associative', () => {
    fc.assert(
      fc.property(copyArb, copyArb, copyArb, (x, y, z) => {
        const [a, b, c] = [app(1, 1, 0, x), app(1, 1, 0, y), app(1, 1, 0, z)];
        expect(pickIdentityCopy(a, b)).toEqual(pickIdentityCopy(b, a));
        expect(pickIdentityCopy(pickIdentityCopy(a, b), c)).toEqual(pickIdentityCopy(a, pickIdentityCopy(b, c)));
      }),
    );
  });
});
