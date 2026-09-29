/**
 * Steps 6 (end) to 8 of the unlock sequence for a shared vault (spec 6.3, 6.7, 6.11): the
 * session runtime and the sync engine around the opened
 * replica, the replica's open notices and a same-device-copy prompt, one unlock cycle (or the
 * first publish of a new vault) within UNLOCK_CYCLE_BUDGET_MS, then this device's presence
 * (session_open = 1) and, when the effective limit is 1, the owner claim, written after that
 * cycle so the new claim outranks older ones, plus the owner tag when the grant says this
 * account owns the vault (docs/PLAN_ENFORCEMENT.md 3.2); finally engine.start() and runtime.start().
 */

import path from 'node:path';
import { presenceWrite } from '../sync/capture-local.js';
import { accountHint } from '../sync/hashing.js';
import { SESSION_LOG_PREFIX } from '../sync/host.js';
import { UNLOCK_CYCLE_BUDGET_MS, type SyncEngine } from '../sync/sync-engine.js';
import type { ReplicaPort } from '../sync/replica.js';
import type { LocalNotice } from '../sync/types.js';
import type { AcquireResult } from './session-client.js';
import type { Rollback } from './open-async.js';
import { raceTimeout } from '../sync/sync-engine-timers.js';
import type { SameDeviceCopy } from './open-binding.js';
import type { OpenContext } from './open-deps.js';
import type { VaultLocation } from './open-location.js';
import type { OkDecision } from './open-password.js';
import type { OpenedPersonalVault } from './open-personal-vault.js';
import { errCode } from './open-staging.js';
import { ownerHint, ownerTagWritesFor } from './owner-tag.js';

export interface StartInput {
  readonly replica: ReplicaPort;
  readonly notices: readonly LocalNotice[];
  readonly acquire: AcquireResult | null;
  readonly copyOf: SameDeviceCopy | null;
  readonly unlock: OkDecision | null;
  /** New vault: the first step is engine.publishInitial() instead of the unlock cycle. */
  readonly create: boolean;
  /** A legacy change on a pre-sync S (the password and the previous one were both given). */
  readonly adoptLegacyChange: boolean;
}

export async function startSharedSession(
  ctx: OpenContext,
  loc: VaultLocation,
  st: StartInput,
  rollback: Rollback,
): Promise<OpenedPersonalVault> {
  const { replica } = st;
  const runtime = ctx.c.createRuntime({
    host: ctx.host,
    config: ctx.config,
    lineageId: replica.lineageId,
    shared: true,
    fileName: ctx.fileName,
    client: ctx.client,
    lease: ctx.lease,
    replica,
  });
  const engine = ctx.c.assembleEngine({ host: ctx.host, replica, session: runtime.signals(), realpath: loc.realpath });
  runtime.attachEngine(engine);
  rollback.push('stop engine', () => engine.stop());
  if (st.notices.length > 0) engine.parts().notices.addFromCapture(st.notices);
  if (st.copyOf !== null) raiseSameDeviceCopy(engine, st.copyOf);
  const pending = await firstCycle(ctx, engine, st.create);
  await presenceAndClaim(ctx, replica, engine, st.acquire, pending);
  if (st.adoptLegacyChange) await adoptLegacyChange(ctx, engine, pending);
  engine.start();
  // The engine subscribes to local commits in start(), so it missed the presence write above;
  // without this the new presence and claim wait for the safety poll (up to a minute).
  if (!pending) engine.trigger('local-edit');
  runtime.start(st.acquire);
  ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: shared vault open`, {
    lineageId: replica.lineageId,
    lease: st.acquire?.kind ?? 'none',
    firstCyclePending: pending,
  });
  return { lineageId: replica.lineageId, shared: true, runtime, replica, engine, unlock: st.unlock, firstCyclePending: pending };
}

function raiseSameDeviceCopy(engine: SyncEngine, copy: SameDeviceCopy): void {
  engine.parts().status.setPrompt({
    kind: 'same-device-copy',
    id: `same-device-copy:${copy.path}`,
    copy: { path: copy.path, name: path.basename(copy.path), sha256: copy.sha256, cls: 'needs-review', changes: 0, deletions: 0 },
  });
}

/** Step 7: true when the cycle is still running after the budget (it is not aborted). */
async function firstCycle(ctx: OpenContext, engine: SyncEngine, create: boolean): Promise<boolean> {
  const { logger } = ctx.host;
  // Started through a resolved promise so a synchronous throw is logged like a failed cycle.
  const run = Promise.resolve().then(async () => {
    if (create) {
      const ok = await engine.publishInitial();
      if (!ok) logger.warn(`${SESSION_LOG_PREFIX} open: first publish of the new vault did not complete`);
      return;
    }
    const outcome = await engine.runCycle('unlock');
    logger.info(`${SESSION_LOG_PREFIX} open: unlock cycle finished`, { outcome: outcome.kind });
  });
  const settled = run.catch((err: unknown) => {
    logger.error(`${SESSION_LOG_PREFIX} open: unlock cycle failed; the vault stays open on the working copy`, { code: errCode(err) });
  });
  const bounded = await raceTimeout(settled, UNLOCK_CYCLE_BUDGET_MS, ctx.host.timers);
  return bounded.kind !== 'done';
}

/**
 * Presence and owner claim in one operation. After a finished first cycle it runs at once
 * (and a failure fails the open); while that cycle still runs it is queued behind it in the
 * engine's lane and a failure is logged.
 */
async function presenceAndClaim(
  ctx: OpenContext,
  replica: ReplicaPort,
  engine: SyncEngine,
  acquire: AcquireResult | null,
  cyclePending: boolean,
): Promise<void> {
  if (!cyclePending) {
    writePresenceAndClaim(ctx, replica, engine, acquire);
    return;
  }
  void engine
    .exclusive(() => writePresenceAndClaim(ctx, replica, engine, acquire))
    .catch((err: unknown) => {
      ctx.host.logger.error(`${SESSION_LOG_PREFIX} open: presence and owner claim were not written`, { code: errCode(err) });
    });
}

/**
 * 4.8 / 12 row 64 with both passwords typed at unlock: the engine absorbs the legacy change
 * found in S after its first cycle. A failure leaves the epoch-legacy prompt for the user.
 */
async function adoptLegacyChange(ctx: OpenContext, engine: SyncEngine, cyclePending: boolean): Promise<void> {
  const { logger } = ctx.host;
  const run = Promise.resolve()
    .then(() => engine.adoptLegacyPasswordChange(ctx.input.password, ctx.input.previousPassword))
    .then(() => logger.info(`${SESSION_LOG_PREFIX} open: adopted the legacy password change`))
    .catch((err: unknown) => {
      logger.warn(`${SESSION_LOG_PREFIX} open: legacy password change not adopted; the prompt stays`, { code: errCode(err) });
    });
  if (!cyclePending) await run;
}

function writePresenceAndClaim(ctx: OpenContext, replica: ReplicaPort, engine: SyncEngine, acquire: AcquireResult | null): void {
  const nowMs = ctx.host.clock.now();
  const userId = ctx.host.account.userId();
  const hint = userId === null ? null : accountHint(replica.lineageId, userId);
  const prev = ctx.c.readPresence(replica.state(), ctx.config.deviceUuid)?.value ?? null;
  const presence = ctx.c.buildPresence(prev, {
    device: ctx.host.device.current(),
    nowMs,
    sessionOpen: true,
    sessionSinceMs: ctx.openedAtMs,
    accountHint: hint,
    fileHint: engine.parts().binding.fileHint(),
    sideFilesSeenMs: prev?.side_files_seen_ms ?? null,
  });
  const rctx = replica.context();
  const limit = limitAfterAcquire(ctx, replica, acquire, nowMs);
  const claims = ctx.c.claimsApply(limit) ? ctx.c.claimWrites(hint, rctx) : [];
  const ownership = acquire?.kind === 'granted' ? acquire.ownership : null;
  const tag = ownerTagWritesFor(ownership, userId === null ? null : ownerHint(replica.lineageId, userId), replica.state(), rctx);
  replica.applyWrites([presenceWrite(presence, rctx), ...claims, ...tag], { interactive: true, ruleR: false });
}

/** 6.8 from the acquire answer (the runtime takes over the lease state at start). */
function limitAfterAcquire(ctx: OpenContext, replica: ReplicaPort, acquire: AcquireResult | null, nowMs: number): number {
  const granted = acquire?.kind === 'granted' ? acquire : null;
  return ctx.c.effectiveLimit({
    signedIn: ctx.signedIn,
    confirmed: granted !== null,
    serverLimit: granted?.limit ?? null,
    localLast: replica.local().lastLimit,
    tierCache: ctx.host.tierCache.read(),
    nowMs,
  }).limit;
}
