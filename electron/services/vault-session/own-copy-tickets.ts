/**
 * "Make my own copy" tickets (docs/PLAN_ENFORCEMENT.md 4.5, decision 3): a not-owner refusal
 * comes after the password check, so the verified keys are kept here, in memory only, for ten
 * minutes. The renderer only ever sees the ticket id. One live ticket per source; a ticket is
 * zeroed and dropped when a copy is made with it, when it expires (a timer prunes it), and on
 * lock, sign-out and quit. A failed copy keeps the ticket so the user can try again.
 */

import crypto from 'node:crypto';

export const OWN_COPY_TICKET_TTL_MS = 10 * 60 * 1000;

export type TicketSource =
  /**
   * This device's working copy W of the lineage (holds edits that never reached the shared
   * file). The shared file is the fallback when W cannot be read or no ticket key opens it.
   */
  | { readonly kind: 'working'; readonly lineageId: string; readonly sharedPath: string }
  /** The shared (or private) vault file itself, when there is no W. */
  | { readonly kind: 'shared'; readonly path: string };

export interface OwnCopyTicket {
  readonly source: TicketSource;
  /** The accepted key first, then W's previous-epoch key when the unlock had one. Owned by the ticket. */
  readonly keys: readonly Buffer[];
  readonly lineageId: string;
  readonly expiresAtMs: number;
}

export interface TicketRegistration {
  readonly source: TicketSource;
  readonly keys: readonly Buffer[];
  readonly lineageId: string;
  readonly nowMs: number;
}

export interface TicketTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: TicketTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function sourceId(source: TicketSource): string {
  return source.kind === 'working' ? `w:${source.lineageId}` : `s:${source.path}`;
}

export class OwnCopyTickets {
  private readonly tickets = new Map<string, OwnCopyTicket>();
  private timer: { readonly handle: unknown; readonly atMs: number } | null = null;

  constructor(
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly timers: TicketTimers = NODE_TIMERS,
  ) {}

  /** Stores copies of `keys` and returns the ticket id; an older ticket for the same source is zeroed. */
  register(input: TicketRegistration): string {
    this.prune(input.nowMs);
    const id = sourceId(input.source);
    for (const [ticketId, t] of this.tickets) {
      if (sourceId(t.source) === id) this.drop(ticketId);
    }
    const ticketId = this.newId();
    this.tickets.set(ticketId, {
      source: input.source,
      keys: input.keys.map((k) => Buffer.from(k)),
      lineageId: input.lineageId,
      expiresAtMs: input.nowMs + OWN_COPY_TICKET_TTL_MS,
    });
    this.schedule(input.nowMs);
    return ticketId;
  }

  /** A live ticket, left in place until `consume`; null when unknown or expired (an expired one is zeroed). */
  get(ticketId: string, nowMs: number): OwnCopyTicket | null {
    this.prune(nowMs);
    return this.tickets.get(ticketId) ?? null;
  }

  /** The copy was made: zero and drop the ticket. */
  consume(ticketId: string): void {
    this.drop(ticketId);
  }

  /** Zeroes and drops every expired ticket. */
  prune(nowMs: number): void {
    for (const [ticketId, t] of this.tickets) {
      if (t.expiresAtMs <= nowMs) this.drop(ticketId);
    }
  }

  /** Lock, sign-out and quit. */
  clear(): void {
    for (const ticketId of [...this.tickets.keys()]) this.drop(ticketId);
  }

  size(): number {
    return this.tickets.size;
  }

  private drop(ticketId: string): void {
    for (const key of this.tickets.get(ticketId)?.keys ?? []) key.fill(0);
    this.tickets.delete(ticketId);
    if (this.tickets.size === 0) this.cancelTimer();
  }

  /** One timer, set for the earliest expiry; it prunes at that moment and sets itself again. */
  private schedule(nowMs: number): void {
    let atMs = Infinity;
    for (const t of this.tickets.values()) atMs = Math.min(atMs, t.expiresAtMs);
    if (atMs === Infinity || this.timer?.atMs === atMs) return;
    this.cancelTimer();
    const handle = this.timers.setTimeout(() => {
      this.timer = null;
      this.prune(atMs);
      this.schedule(atMs);
    }, Math.max(0, atMs - nowMs));
    this.timer = { handle, atMs };
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer.handle);
    this.timer = null;
  }
}
