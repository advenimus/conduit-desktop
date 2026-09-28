// @vitest-environment node
// Cloud backup snapshot names: unique within one second (two uploads in the same second used to
// collide with "The resource already exists"), still a vault_*.enc object the listing keeps.
import { describe, expect, it } from 'vitest';
import { snapshotFileName } from '../cloud-backup-name.js';

describe('snapshotFileName', () => {
  it('names the UTC time to the millisecond plus a random tag', () => {
    expect(snapshotFileName(new Date('2026-09-26T14:03:07.412Z'), 'a1b2c3')).toBe('vault_2026-09-26_14-03-07-412_a1b2c3.enc');
  });

  it('gives two uploads in the same millisecond different names', () => {
    const now = new Date('2026-09-26T14:03:07.412Z');
    const names = new Set(Array.from({ length: 50 }, () => snapshotFileName(now)));
    expect(names.size).toBe(50);
    for (const n of names) expect(n).toMatch(/^vault_2026-09-26_14-03-07-412_[0-9a-f]{6}\.enc$/);
  });

  it('two uploads within one second no longer share a name', () => {
    const a = snapshotFileName(new Date('2026-09-26T14:03:07.100Z'), '000000');
    const b = snapshotFileName(new Date('2026-09-26T14:03:07.900Z'), '000000');
    expect(a).not.toBe(b);
  });
});
