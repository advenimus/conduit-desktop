/**
 * The in-file owner tag (docs/PLAN_ENFORCEMENT.md 3): the `_sync/owner/account` register
 * {"a": account_hint or null}, written only by a device whose last confirmed lease answer said
 * `ownership: owner` (or {"a": null} right after a confirmed release). At unlock it is a backup
 * signal for honest apps when the server cannot answer; the server decides everything else.
 * Pure except for the write helpers.
 */

import { ownerTagWrite } from '../sync/capture-local.js';
import { ACCOUNT_REG, ownerTagRegKey } from '../sync/catalog.js';
import { accountHint } from '../sync/hashing.js';
import { getRegister, provisional } from '../sync/state-view.js';
import type { LocalWrite, OwnerCheck, SyncContext, SyncState } from '../sync/types.js';
import type { Ownership } from './session-client.js';

const HINT_RE = /^[0-9a-f]{32}$/;
/** An ownerCheck dated more than this in the future is ignored (same rule as the tier cache). */
export const OWNER_CHECK_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface OwnerTag {
  readonly a: string | null;
  /** HLC ms of the provisional sibling. */
  readonly ms: number;
}

export type OwnerTagVerdict = 'allow' | 'sign-in' | 'not-owner-offline';

/** The account hint of `userId` for this lineage; both platforms hash the lowercase user id. */
export function ownerHint(lineageId: string, userId: string): string {
  return accountHint(lineageId, userId.toLowerCase());
}

function parseTag(text: string): { readonly a: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const a = (raw as Record<string, unknown>).a;
  if (a === null) return { a: null };
  return typeof a === 'string' && HINT_RE.test(a) ? { a } : null;
}

/** Provisional owner tag, or null when absent or not a valid value. */
export function readOwnerTag(state: SyncState): OwnerTag | null {
  const reg = getRegister(state, ownerTagRegKey());
  if (reg === undefined) return null;
  const top = provisional(ACCOUNT_REG, reg.sibs);
  if (top === null || typeof top.value !== 'string') return null;
  const value = parseTag(top.value);
  return value === null ? null : Object.freeze({ a: value.a, ms: top.ms });
}

export interface OwnerTagInput {
  readonly signedIn: boolean;
  /** The early peek got a server answer. */
  readonly peekConfirmed: boolean;
  readonly userId: string | null;
  readonly lineageId: string;
  readonly tag: OwnerTag | null;
  readonly ownerCheck: OwnerCheck | null;
  readonly nowMs: number;
}

function usableCheck(check: OwnerCheck | null, nowMs: number): OwnerCheck | null {
  if (check === null) return null;
  return check.atMs > nowMs + OWNER_CHECK_FUTURE_TOLERANCE_MS ? null : check;
}

/** Plan enforcement 3.4 decision table. */
export function evaluateOwnerTag(input: OwnerTagInput): OwnerTagVerdict {
  const { tag } = input;
  if (input.signedIn && input.peekConfirmed) return 'allow';
  if (tag === null || tag.a === null) return 'allow';
  const check = usableCheck(input.ownerCheck, input.nowMs);
  if (input.signedIn && input.userId !== null) {
    const own = ownerHint(input.lineageId, input.userId);
    if (tag.a === own) return 'allow';
    if (check === null || check.hint !== own) return 'not-owner-offline';
    const newerOwner = check.kind === 'owner' && check.atMs > tag.ms;
    const liveGrace = check.kind === 'grace' && check.untilMs !== null && check.untilMs > input.nowMs;
    return newerOwner || liveGrace ? 'allow' : 'not-owner-offline';
  }
  if (check !== null && check.kind === 'owner' && (check.hint === tag.a || check.atMs > tag.ms)) return 'allow';
  return 'sign-in';
}

/** 3.2: a confirmed owner writes its hint when the provisional tag differs. */
export function ownerTagWritesFor(ownership: Ownership | null, hint: string | null, state: SyncState, ctx: SyncContext): readonly LocalWrite[] {
  if (ownership?.kind !== 'owner' || hint === null) return [];
  if (readOwnerTag(state)?.a === hint) return [];
  return [ownerTagWrite({ a: hint }, ctx)];
}

/** 3.2: {"a": null} after a confirmed release (`released: true`), unless the tag already says so. */
export function releasedTagWrites(state: SyncState, ctx: SyncContext): readonly LocalWrite[] {
  const tag = readOwnerTag(state);
  if (tag !== null && tag.a === null) return [];
  return [ownerTagWrite({ a: null }, ctx)];
}
