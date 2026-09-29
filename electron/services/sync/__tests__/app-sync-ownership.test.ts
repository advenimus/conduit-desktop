// @vitest-environment node
// sync_get_state ownership (docs/PLAN_ENFORCEMENT.md 4.7): the last confirmed answer, else unknown.
import { describe, expect, it } from 'vitest';
import { ownershipDto } from '../app-sync-dto-map.js';

const OWNER = { kind: 'owner', releaseAfterMs: 5, sharedUntilMs: null } as const;

describe('ownershipDto', () => {
  it('passes a confirmed answer through', () => {
    expect(ownershipDto({ confirmed: true, ownership: OWNER, deviceCap: 5 }, true, false)).toEqual(OWNER);
    expect(ownershipDto({ confirmed: true, ownership: { kind: 'grace', untilMs: 9 }, deviceCap: 5 }, true, false)).toEqual({ kind: 'grace', untilMs: 9 });
  });

  it('is unknown signed out, soft-locked, unconfirmed or without an answer', () => {
    expect(ownershipDto({ confirmed: true, ownership: OWNER, deviceCap: 5 }, false, false)).toEqual({ kind: 'unknown' });
    expect(ownershipDto({ confirmed: true, ownership: OWNER, deviceCap: 5 }, true, true)).toEqual({ kind: 'unknown' });
    expect(ownershipDto({ confirmed: false, ownership: OWNER, deviceCap: 5 }, true, false)).toEqual({ kind: 'unknown' });
    expect(ownershipDto({ confirmed: true, ownership: null, deviceCap: null }, true, false)).toEqual({ kind: 'unknown' });
  });
});
