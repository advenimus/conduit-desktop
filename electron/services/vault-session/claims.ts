/**
 * In-file owner claims (spec 6.7, 12 rows 28/29/62/63): the `_sync/owner/owner` register
 * {"a": account_hint or null, "d": device_uuid}. Written by a device whose effective limit is 1
 * (shared vaults only) at unlock and take-over; honored by every device whose effective limit
 * is 1: the provisional (highest-rank) claim is authoritative, except when BOTH this device and
 * the claimant hold a live server lease (the claimant's device_uuid is active in this device's
 * latest sessions and this device is confirmed). Evaluated after every merge. Pure except for
 * the write helper.
 */

import { ownerClaimWrite } from '../sync/capture-local.js';
import { OWNER_REG, ownerRegKey } from '../sync/catalog.js';
import { isRecentlyActive, readPresence } from '../sync/presence.js';
import { getRegister, provisional } from '../sync/state-view.js';
import type { SessionRowView } from '../sync/host.js';
import type { LocalWrite, OwnerClaimValue, PresenceValue, SyncContext, SyncState } from '../sync/types.js';
import { claimsApply } from './effective-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnerClaim {
  readonly value: OwnerClaimValue;
  /** Dot of the provisional claim sibling (rank decides; app dots only in practice). */
  readonly ms: number;
  readonly dev: number;
}

function sameUuid(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function parseOwnerClaim(text: string): OwnerClaimValue | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { a, d } = raw as Record<string, unknown>;
  if (typeof d !== 'string' || !UUID_RE.test(d)) return null;
  if (a !== null && typeof a !== 'string') return null;
  return Object.freeze({ a, d });
}

/** Provisional owner claim, or null when absent or unparseable. */
export function readOwnerClaim(state: SyncState): OwnerClaim | null {
  const reg = getRegister(state, ownerRegKey());
  if (reg === undefined) return null;
  const top = provisional(OWNER_REG, reg.sibs);
  if (top === null || typeof top.value !== 'string') return null;
  const value = parseOwnerClaim(top.value);
  return value === null ? null : Object.freeze({ value, ms: top.ms, dev: top.dev });
}

export interface ClaimInputs {
  readonly state: SyncState;
  readonly ownDeviceUuid: string;
  readonly effectiveLimit: number;
  /** Shared vault (3.2); private vaults never use claims. */
  readonly shared: boolean;
  readonly leaseConfirmed: boolean;
  readonly sessions: readonly SessionRowView[];
  readonly nowMs: number;
}

export type ClaimVerdict =
  /** Limit is not 1, or not shared: claims do not apply. */
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ours' }
  /** Both hold live leases: the server decides. */
  | { readonly kind: 'ignored-leased'; readonly claimantUuid: string }
  | {
      readonly kind: 'other';
      readonly claimantUuid: string;
      readonly presence: PresenceValue | null;
      /** presence.isRecentlyActive (session_open and activity within 15 min, future times ignored). */
      readonly recentlyActive: boolean;
    };

const NOT_APPLICABLE: ClaimVerdict = Object.freeze({ kind: 'not-applicable' });
const NONE: ClaimVerdict = Object.freeze({ kind: 'none' });
const OURS: ClaimVerdict = Object.freeze({ kind: 'ours' });

/** The claimant appears with a live lease in this device's latest sessions (same account only). */
function claimantLeased(sessions: readonly SessionRowView[], claimantUuid: string): boolean {
  return sessions.some((row) => row.status === 'active' && sameUuid(row.deviceId, claimantUuid));
}

export function evaluateClaims(input: ClaimInputs): ClaimVerdict {
  if (!input.shared || !claimsApply(input.effectiveLimit)) return NOT_APPLICABLE;
  const claim = readOwnerClaim(input.state);
  if (claim === null) return NONE;
  const claimantUuid = claim.value.d;
  if (sameUuid(claimantUuid, input.ownDeviceUuid)) return OURS;
  if (input.leaseConfirmed && claimantLeased(input.sessions, claimantUuid)) {
    return { kind: 'ignored-leased', claimantUuid };
  }
  const presence = readPresence(input.state, claimantUuid)?.value ?? null;
  const recentlyActive = presence !== null && isRecentlyActive(presence, input.nowMs);
  return { kind: 'other', claimantUuid, presence, recentlyActive };
}

/** 6.7 at unlock: 'other' + recentlyActive -> prompt (take-over dialog); otherwise claim silently. */
export function unlockClaimAction(verdict: ClaimVerdict): 'prompt' | 'claim' | 'skip' {
  if (verdict.kind === 'not-applicable') return 'skip';
  if (verdict.kind === 'other' && verdict.recentlyActive) return 'prompt';
  return 'claim';
}

/** 6.7 on every merge: displaced when the provisional owner is another device (not ignored). */
export function shouldDisplace(verdict: ClaimVerdict): boolean {
  return verdict.kind === 'other';
}

/** The claim write (capture-local.ownerClaimWrite) for replica.applyWrites({ interactive: true, ruleR: false }). */
export function claimWrites(accountHint: string | null, ctx: SyncContext): readonly LocalWrite[] {
  return Object.freeze([ownerClaimWrite({ a: accountHint, d: ctx.deviceUuid }, ctx)]);
}
