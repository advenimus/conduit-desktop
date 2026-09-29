/**
 * The server side of an open (spec 6.3 steps 3 and 5, 6.5, 6.7, 6.8, 8 error semantics;
 * docs/PLAN_ENFORCEMENT.md 3.4, 4.3): the early in-use check before any password work
 * (vault_session_peek, 3 s; an update-required or device-cap answer refuses there; a server
 * problem falls back to the in-file owner tag, then the owner claims on the peeked file when
 * the effective limit is 1), and the acquire after the password was accepted (a well-formed
 * denial is the take-over dialog, not-owner is "Make my own copy", update-required the update
 * notice; any server problem continues unconfirmed; a granted lease is released if the open
 * fails later).
 */

import path from 'node:path';
import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { LocalJson, SyncState } from '../sync/types.js';
import { UNLIMITED } from './effective-limit.js';
import type { Rollback } from './open-async.js';
import { raceTimeout } from '../sync/sync-engine-timers.js';
import type { OpenContext } from './open-deps.js';
import { holderFromClaim, notOwnerError, openElsewhereError, signInRequiredError, updateRequiredError } from './open-errors.js';
import type { TicketSource } from './own-copy-tickets.js';
import { evaluateOwnerTag, readOwnerTag } from './owner-tag.js';
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
    if (res.refusal?.kind === 'update-required') throw updateRequiredError(ctx.fileName, res.refusal.minVersion);
    const own = ownLocation(ctx, loc);
    if (res.limit !== UNLIMITED && res.holders.length >= res.limit) {
      throw openElsewhereError({ holders: res.holders, limit: res.limit, fileName: ctx.fileName, ownLocation: own, via: 'server', deviceCap: res.deviceCap });
    }
    if (res.refusal?.kind === 'device-cap') {
      const { devices, deviceCap } = res.refusal;
      throw openElsewhereError({ holders: devices, limit: res.limit, fileName: ctx.fileName, ownLocation: own, via: 'server', cause: 'device_cap', deviceCap });
    }
    return;
  }
  logUnconfirmed(ctx, 'peek', res);
  checkOwnerTagAtUnlock(ctx, g);
  checkClaimsAtUnlock(ctx, loc, g);
}

/** Plan enforcement 3.4: signed out or unconfirmed, the owner tag decides before the claims (a non-owner must not take over). */
function checkOwnerTagAtUnlock(ctx: OpenContext, g: GateInput): void {
  if (!g.shared || g.claimState === null) return;
  const verdict = evaluateOwnerTag({
    signedIn: ctx.signedIn,
    peekConfirmed: false,
    userId: ctx.host.account.userId(),
    lineageId: g.lineageId,
    tag: readOwnerTag(g.claimState),
    ownerCheck: g.local?.ownerCheck ?? null,
    nowMs: ctx.host.clock.now(),
  });
  if (verdict === 'sign-in') throw signInRequiredError(ctx.fileName);
  if (verdict === 'not-owner-offline') {
    throw notOwnerError({ fileName: ctx.fileName, offline: true, graceEndedMs: null, released: false, copyTicket: null, copyDir: null });
  }
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

/** What "Make my own copy" forks after a not-owner refusal, and the verified keys that may open it. */
export interface CopySource {
  readonly source: TicketSource;
  /** The accepted key first, then W's previous-epoch key; empty: no copy can be offered (a private file without a salt). */
  readonly keys: readonly Buffer[];
}

/**
 * Step 5 (signed in only). Every open is started by the user, so it claims an unowned vault
 * (p_claim true). Denied throws VAULT_OPEN_ELSEWHERE, not-owner VAULT_NOT_OWNER with a copy
 * ticket, update-required VAULT_UPDATE_REQUIRED; a granted lease is released on rollback.
 */
export async function acquireLease(
  ctx: OpenContext,
  loc: VaultLocation,
  lineageId: string,
  fileId: string | null,
  rollback: Rollback,
  copy: CopySource,
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
    claim: true,
  };
  const bounded = await raceTimeout(ctx.client.acquire(args), RPC_TIMEOUT_MS, ctx.host.timers);
  const res: AcquireResult = bounded.kind === 'done' ? bounded.value : ACQUIRE_TIMED_OUT;
  switch (res.kind) {
    case 'denied':
      throw openElsewhereError({
        holders: res.holders,
        limit: res.limit,
        fileName: ctx.fileName,
        ownLocation: args.location ?? '',
        via: 'server',
        cause: res.cause,
        deviceCap: res.deviceCap,
        alsoLockDeviceName: res.alsoLocks === null ? null : (res.alsoLocks.deviceName ?? ''),
      });
    case 'not-owner':
      throw notOwnerError({
        fileName: ctx.fileName,
        offline: false,
        graceEndedMs: res.graceEndedMs,
        released: res.released,
        copyTicket: copy.keys.length === 0 ? null : ctx.tickets.register({ source: copy.source, keys: copy.keys, lineageId, nowMs: ctx.host.clock.now() }),
        copyDir: path.dirname(ctx.sharedPath),
      });
    case 'update-required':
      throw updateRequiredError(ctx.fileName, res.minVersion);
    case 'granted':
      rollback.push('release lease', () => releaseBounded(ctx, lineageId, res.leaseId));
      return res;
    default:
      logUnconfirmed(ctx, 'acquire', res);
      return res;
  }
}

/** vault_session_release of a lease this failed open took (bounded; never throws). */
async function releaseBounded(ctx: OpenContext, lineageId: string, leaseId: string): Promise<void> {
  const args = { vaultKey: lineageId, deviceId: ctx.config.deviceUuid, leaseId, marker: null, pending: false };
  const res = await raceTimeout(ctx.client.release(args, RPC_TIMEOUT_MS), RPC_TIMEOUT_MS, ctx.host.timers);
  if (res.kind !== 'done') ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: lease release timed out after a failed open`);
  else if (res.value.kind !== 'ok') logUnconfirmed(ctx, 'release', res.value);
}
