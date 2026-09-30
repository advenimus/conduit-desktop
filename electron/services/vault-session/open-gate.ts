/**
 * The server side of an open (spec 6.3 steps 3 and 5, 6.5, 6.7, 6.8, 8 error semantics):
 * the early in-use check before any password work (vault_session_peek, 3 s, a server problem
 * falls back to owner claims on the peeked file when the effective limit is 1), and the
 * acquire after the password was accepted (a well-formed denial is the take-over dialog; any
 * server problem continues unconfirmed; a granted lease is released if the open fails later).
 */

import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { LocalJson, SyncState } from '../sync/types.js';
import { UNLIMITED } from './effective-limit.js';
import type { Rollback } from './open-async.js';
import { raceTimeout } from '../sync/sync-engine-timers.js';
import type { OpenContext } from './open-deps.js';
import { holderFromClaim, openElsewhereError } from './open-errors.js';
import type { VaultLocation } from './open-location.js';
import {
  EARLY_CHECK_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  type AcquireArgs,
  type AcquireResult,
  type PeekResult,
  type Unconfirmed,
} from './session-client.js';

const EARLY_CHECK_TIMED_OUT: Unconfirmed = { kind: 'unconfirmed', reason: 'timeout', detail: 'early-check' };
const ACQUIRE_TIMED_OUT: Unconfirmed = { kind: 'unconfirmed', reason: 'timeout', detail: 'acquire' };

export interface GateInput {
  readonly lineageId: string;
  readonly shared: boolean;
  /** Where the owner claim is read at unlock: the peeked S, else W; null skips claims. */
  readonly claimState: SyncState | null;
  readonly local: LocalJson | null;
}

export function ownLocation(ctx: OpenContext, loc: VaultLocation): string {
  const { paths } = ctx.host;
  return ctx.c.locationOf(loc.realpath, paths.platform, (p) => paths.isNetworkPath(p));
}

function logUnconfirmed(ctx: OpenContext, call: string, res: Unconfirmed): void {
  ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: ${call} unconfirmed; continuing`, { reason: res.reason, detail: res.detail });
}

/** Step 3: refuses before the password prompt when another device holds the vault (not on take-over). */
export async function earlyInUseCheck(ctx: OpenContext, loc: VaultLocation, g: GateInput): Promise<void> {
  if (ctx.input.takeover) return;
  const ids = { vaultKey: g.lineageId, deviceId: ctx.config.deviceUuid };
  const bounded = await raceTimeout(ctx.client.peek(ids, EARLY_CHECK_TIMEOUT_MS), EARLY_CHECK_TIMEOUT_MS, ctx.host.timers);
  const res: PeekResult = bounded.kind === 'done' ? bounded.value : EARLY_CHECK_TIMED_OUT;
  if (res.kind === 'ok') {
    if (res.limit !== UNLIMITED && res.holders.length >= res.limit) {
      throw openElsewhereError({ holders: res.holders, limit: res.limit, fileName: ctx.fileName, ownLocation: ownLocation(ctx, loc), via: 'server' });
    }
    return;
  }
  logUnconfirmed(ctx, 'peek', res);
  checkClaimsAtUnlock(ctx, loc, g);
}

/** 6.7 prompt at unlock: the provisional owner is another device active within 15 minutes. */
function checkClaimsAtUnlock(ctx: OpenContext, loc: VaultLocation, g: GateInput): void {
  if (!g.shared || g.claimState === null) return;
  const nowMs = ctx.host.clock.now();
  const { limit } = ctx.c.effectiveLimit({
    signedIn: ctx.signedIn,
    confirmed: false,
    serverLimit: null,
    localLast: g.local?.lastLimit ?? null,
    tierCache: ctx.host.tierCache.read(),
    nowMs,
  });
  if (!ctx.c.claimsApply(limit)) return;
  const verdict = ctx.c.evaluateClaims({
    state: g.claimState,
    ownDeviceUuid: ctx.config.deviceUuid,
    effectiveLimit: limit,
    shared: true,
    leaseConfirmed: false,
    sessions: [],
    nowMs,
  });
  if (verdict.kind === 'other' && ctx.c.unlockClaimAction(verdict) === 'prompt') {
    throw openElsewhereError({ holders: [holderFromClaim(verdict)], limit, fileName: ctx.fileName, ownLocation: ownLocation(ctx, loc), via: 'claim' });
  }
}

/** Step 5 (signed in only). Denied throws VAULT_OPEN_ELSEWHERE; a granted lease is released on rollback. */
export async function acquireLease(
  ctx: OpenContext,
  loc: VaultLocation,
  lineageId: string,
  fileId: string | null,
  rollback: Rollback,
): Promise<AcquireResult | null> {
  if (!ctx.signedIn) return null;
  const device = ctx.host.device.current();
  const args: AcquireArgs = {
    vaultKey: lineageId,
    deviceId: ctx.config.deviceUuid,
    sessionNonce: ctx.config.sessionNonce,
    deviceName: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    fileName: ctx.fileName,
    fileId,
    location: ownLocation(ctx, loc),
    takeover: ctx.input.takeover,
  };
  const bounded = await raceTimeout(ctx.client.acquire(args), RPC_TIMEOUT_MS, ctx.host.timers);
  const res: AcquireResult = bounded.kind === 'done' ? bounded.value : ACQUIRE_TIMED_OUT;
  if (res.kind === 'denied') {
    throw openElsewhereError({ holders: res.holders, limit: res.limit, fileName: ctx.fileName, ownLocation: args.location ?? '', via: 'server' });
  }
  if (res.kind === 'granted') rollback.push('release lease', () => releaseBounded(ctx, lineageId, res.leaseId));
  else logUnconfirmed(ctx, 'acquire', res);
  return res;
}

/** vault_session_release of a lease this failed open took (bounded; never throws). */
async function releaseBounded(ctx: OpenContext, lineageId: string, leaseId: string): Promise<void> {
  const args = { vaultKey: lineageId, deviceId: ctx.config.deviceUuid, leaseId, marker: null, pending: false };
  const res = await raceTimeout(ctx.client.release(args, RPC_TIMEOUT_MS), RPC_TIMEOUT_MS, ctx.host.timers);
  if (res.kind !== 'done') ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: lease release timed out after a failed open`);
  else if (res.value.kind !== 'ok') logUnconfirmed(ctx, 'release', res.value);
}
