// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OWN_COPY_TICKET_TTL_MS, OwnCopyTickets, type TicketTimers } from '../own-copy-tickets.js';

const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
const WORKING = { kind: 'working', lineageId: LINEAGE, sharedPath: '/v/Vault.conduit' } as const;

function counter(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

/** Timers the test fires by hand. */
function manualTimers(): TicketTimers & { pending: () => { fn: () => void; ms: number }[]; fire: () => void } {
  const live = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    setTimeout: (fn, ms) => {
      live.set(++n, { fn, ms });
      return n;
    },
    clearTimeout: (handle) => {
      live.delete(handle as number);
    },
    pending: () => [...live.values()],
    fire: () => {
      const [id, timer] = [...live.entries()][0] ?? [];
      if (id === undefined || timer === undefined) throw new Error('no timer to fire');
      live.delete(id);
      timer.fn();
    },
  };
}

describe('OwnCopyTickets (plan enforcement 4.5)', () => {
  it('keeps copies of the keys until the copy is made, then zeroes them', () => {
    const tickets = new OwnCopyTickets(counter(), manualTimers());
    const key = Buffer.alloc(32, 7);
    const previous = Buffer.alloc(32, 8);
    const id = tickets.register({ source: { kind: 'shared', path: '/v/Vault.conduit' }, keys: [key, previous], lineageId: LINEAGE, nowMs: 1_000 });
    key.fill(0);
    const t = tickets.get(id, 2_000);
    expect(t?.keys.map((k) => k[0])).toEqual([7, 8]);
    expect(t?.expiresAtMs).toBe(1_000 + OWN_COPY_TICKET_TTL_MS);
    expect(tickets.get(id, 3_000)).toBe(t);
    tickets.consume(id);
    expect(t?.keys.every((k) => k.every((b) => b === 0))).toBe(true);
    expect(tickets.get(id, 3_000)).toBeNull();
  });

  it('an expired ticket is refused and zeroed', () => {
    const tickets = new OwnCopyTickets(counter(), manualTimers());
    const id = tickets.register({ source: WORKING, keys: [Buffer.alloc(32, 1)], lineageId: LINEAGE, nowMs: 0 });
    const t = tickets.get(id, 1);
    expect(tickets.get(id, OWN_COPY_TICKET_TTL_MS)).toBeNull();
    expect(tickets.size()).toBe(0);
    expect(t?.keys[0]?.every((b) => b === 0)).toBe(true);
  });

  it('a timer zeroes an expired ticket without any later call', () => {
    const timers = manualTimers();
    const tickets = new OwnCopyTickets(counter(), timers);
    const id = tickets.register({ source: WORKING, keys: [Buffer.alloc(32, 1)], lineageId: LINEAGE, nowMs: 5 });
    const t = tickets.get(id, 6);
    expect(timers.pending()).toHaveLength(1);
    expect(timers.pending()[0]?.ms).toBe(OWN_COPY_TICKET_TTL_MS);
    timers.fire();
    expect(tickets.size()).toBe(0);
    expect(t?.keys[0]?.every((b) => b === 0)).toBe(true);
    expect(timers.pending()).toHaveLength(0);
  });

  it('the timer follows the earliest live ticket and stops when none is left', () => {
    const timers = manualTimers();
    const tickets = new OwnCopyTickets(counter(), timers);
    tickets.register({ source: { kind: 'shared', path: '/a' }, keys: [Buffer.alloc(8, 1)], lineageId: LINEAGE, nowMs: 0 });
    const later = tickets.register({ source: { kind: 'shared', path: '/b' }, keys: [Buffer.alloc(8, 2)], lineageId: LINEAGE, nowMs: 1_000 });
    expect(timers.pending()).toHaveLength(1);
    timers.fire();
    expect(tickets.size()).toBe(1);
    expect(timers.pending()[0]?.ms).toBe(1_000);
    tickets.consume(later);
    expect(timers.pending()).toHaveLength(0);
  });

  it('one live ticket per source: a new one replaces and zeroes the old', () => {
    const tickets = new OwnCopyTickets(counter(), manualTimers());
    const first = tickets.register({ source: WORKING, keys: [Buffer.alloc(32, 1)], lineageId: LINEAGE, nowMs: 0 });
    const other = tickets.register({ source: { kind: 'shared', path: '/other.conduit' }, keys: [Buffer.alloc(32, 3)], lineageId: LINEAGE, nowMs: 0 });
    const second = tickets.register({ source: WORKING, keys: [Buffer.alloc(32, 2)], lineageId: LINEAGE, nowMs: 0 });
    expect(tickets.get(first, 1)).toBeNull();
    expect(tickets.get(second, 1)?.keys[0]?.[0]).toBe(2);
    expect(tickets.get(other, 1)?.keys[0]?.[0]).toBe(3);
  });

  it('clear (lock, sign-out, quit) and prune zero every key they drop', () => {
    const tickets = new OwnCopyTickets(counter(), manualTimers());
    const reg = (n: number, nowMs: number): string =>
      tickets.register({ source: { kind: 'shared', path: `/v${n}` }, keys: [Buffer.alloc(8, n)], lineageId: LINEAGE, nowMs });
    const old = reg(1, 0);
    const oldKey = tickets.get(old, 0)?.keys[0];
    const live = reg(2, OWN_COPY_TICKET_TTL_MS);
    expect(tickets.size()).toBe(1);
    expect(oldKey?.every((b) => b === 0)).toBe(true);
    const liveKey = tickets.get(live, OWN_COPY_TICKET_TTL_MS + 1)?.keys[0];
    reg(3, OWN_COPY_TICKET_TTL_MS);
    tickets.clear();
    expect(tickets.size()).toBe(0);
    expect(liveKey?.every((b) => b === 0)).toBe(true);
  });
});
