/**
 * "Make my own copy" tickets (docs/PLAN_ENFORCEMENT.md 4.5, decision 3): a not-owner refusal
 * comes after the password check, so the verified key is kept here, in memory only, for ten
 * minutes. The renderer only ever sees the ticket id. One live ticket per source; a ticket is
 * zeroed and dropped when used, when it expires, and on lock, sign-out and quit.
 */

import crypto from 'node:crypto';

export const OWN_COPY_TICKET_TTL_MS = 10 * 60 * 1000;

export type TicketSource =
  /** This device's working copy W of the lineage (holds edits that never reached the shared file). */
  | { readonly kind: 'working'; readonly lineageId: string }
  /** The shared (or private) vault file itself, when there is no W. */
  | { readonly kind: 'shared'; readonly path: string };

export interface OwnCopyTicket {
  readonly source: TicketSource;
  /** Key of the source's current epoch; the caller zeroes it after use. */
  readonly key: Buffer;
  readonly lineageId: string;
  readonly expiresAtMs: number;
}

export interface TicketRegistration {
  readonly source: TicketSource;
  readonly key: Buffer;
  readonly lineageId: string;
  readonly nowMs: number;
}

function sourceId(source: TicketSource): string {
  return source.kind === 'working' ? `w:${source.lineageId}` : `s:${source.path}`;
}

export class OwnCopyTickets {
  private readonly tickets = new Map<string, OwnCopyTicket>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** Stores a copy of `key` and returns the ticket id; an older ticket for the same source is zeroed. */
  register(input: TicketRegistration): string {
    const id = sourceId(input.source);
    for (const [ticketId, t] of this.tickets) {
      if (sourceId(t.source) === id) this.drop(ticketId);
    }
    const ticketId = this.newId();
    this.tickets.set(ticketId, {
      source: input.source,
      key: Buffer.from(input.key),
      lineageId: input.lineageId,
      expiresAtMs: input.nowMs + OWN_COPY_TICKET_TTL_MS,
    });
    return ticketId;
  }

  /** Removes and returns a live ticket; null when unknown or expired (an expired one is zeroed). */
  take(ticketId: string, nowMs: number): OwnCopyTicket | null {
    const t = this.tickets.get(ticketId);
    if (t === undefined) return null;
    this.tickets.delete(ticketId);
    if (t.expiresAtMs <= nowMs) {
      t.key.fill(0);
      return null;
    }
    return t;
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
    this.tickets.get(ticketId)?.key.fill(0);
    this.tickets.delete(ticketId);
  }
}
