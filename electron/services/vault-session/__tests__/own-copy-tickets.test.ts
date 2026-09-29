// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OWN_COPY_TICKET_TTL_MS, OwnCopyTickets } from '../own-copy-tickets.js';

const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';

function counter(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

describe('OwnCopyTickets (plan enforcement 4.5)', () => {
  it('keeps a copy of the key, hands it out once and forgets it', () => {
    const tickets = new OwnCopyTickets(counter());
    const key = Buffer.alloc(32, 7);
    const id = tickets.register({ source: { kind: 'shared', path: '/v/Vault.conduit' }, key, lineageId: LINEAGE, nowMs: 1_000 });
    key.fill(0);
    const t = tickets.take(id, 2_000);
    expect(t?.key.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(t?.expiresAtMs).toBe(1_000 + OWN_COPY_TICKET_TTL_MS);
    expect(tickets.take(id, 2_000)).toBeNull();
  });

  it('an expired ticket is refused and zeroed', () => {
    const tickets = new OwnCopyTickets(counter());
    const id = tickets.register({ source: { kind: 'working', lineageId: LINEAGE }, key: Buffer.alloc(32, 1), lineageId: LINEAGE, nowMs: 0 });
    expect(tickets.take(id, OWN_COPY_TICKET_TTL_MS)).toBeNull();
    expect(tickets.size()).toBe(0);
  });

  it('one live ticket per source: a new one replaces and zeroes the old', () => {
    const tickets = new OwnCopyTickets(counter());
    const first = tickets.register({ source: { kind: 'working', lineageId: LINEAGE }, key: Buffer.alloc(32, 1), lineageId: LINEAGE, nowMs: 0 });
    const other = tickets.register({ source: { kind: 'shared', path: '/other.conduit' }, key: Buffer.alloc(32, 3), lineageId: LINEAGE, nowMs: 0 });
    const second = tickets.register({ source: { kind: 'working', lineageId: LINEAGE }, key: Buffer.alloc(32, 2), lineageId: LINEAGE, nowMs: 0 });
    expect(tickets.take(first, 1)).toBeNull();
    expect(tickets.take(second, 1)?.key[0]).toBe(2);
    expect(tickets.take(other, 1)?.key[0]).toBe(3);
  });

  it('clear (lock, sign-out, quit) and prune zero every key they drop', () => {
    const tickets = new OwnCopyTickets(counter());
    const kept: Buffer[] = [];
    const spy = { register: (n: number, nowMs: number) => tickets.register({ source: { kind: 'shared', path: `/v${n}` }, key: Buffer.alloc(8, n), lineageId: LINEAGE, nowMs }) };
    spy.register(1, 0);
    const live = spy.register(2, OWN_COPY_TICKET_TTL_MS);
    tickets.prune(OWN_COPY_TICKET_TTL_MS + 1);
    expect(tickets.size()).toBe(1);
    const t = tickets.take(live, OWN_COPY_TICKET_TTL_MS + 1);
    if (t !== null) kept.push(t.key);
    spy.register(3, 0);
    tickets.clear();
    expect(tickets.size()).toBe(0);
    expect(kept[0]?.[0]).toBe(2);
  });
});
