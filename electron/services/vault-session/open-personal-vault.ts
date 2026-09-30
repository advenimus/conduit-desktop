/**
 * openPersonalVault (spec 6.3 steps 1-8, 4.4 G1 wait, 4.8 unlock policy, 5.2 classes, 6.5,
 * 6.7 prompt at unlock, 12 rows 26/35/59/62/63/64): the one entry point that replaces the body
 * of all nine personal unlock paths. 1 resolve (realpath, shared or private); 2 peek S through
 * a private copy (nothing in the shared folder is written); 3 early in-use check (peek RPC,
 * 3 s, skipped offline; signed out: owner claims of the peeked file); 4 verify the password
 * (a typo has no side effects); 5 acquire (server errors continue unconfirmed, never deny);
 * 6 open or create W (new incarnation; G1, adopt or new vault; epoch adoption); 7 one cycle
 * with a 3 s budget, presence session_open = 1 and the owner claim when the limit is 1;
 * 8 start engine, heartbeat and Realtime. Errors reach the renderer as JSON in Error.message.
 * Parts: open-location, open-peek, open-staging, open-gate, open-password, open-binding,
 * open-shared, open-start, open-private, open-errors, open-deps, open-async.
 */

import { cleanupScratch } from '../sync/housekeeping-files.js';
import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { IncarnationRegistry, ReplicaPort } from '../sync/replica.js';
import type { AssembleInput, SyncEngine } from '../sync/sync-engine.js';
import type { WaitingState } from '../sync/host.js';
import type { SyncState, UnlockDecision } from '../sync/types.js';
import type { PersonalVaultRuntime } from './session-runtime.js';
import type { SessionConfig, SessionHost } from './host.js';
import { makeOpenContext, type OpenCollaborators, type OpenContext } from './open-deps.js';
import { INVALID_PASSWORD_MESSAGE, PersonalVaultOpenError } from './open-errors.js';
import { earlyInUseCheck } from './open-gate.js';
import { resolveVaultLocation, type VaultLocation } from './open-location.js';
import { verifySharedPassword } from './open-password.js';
import { peekShared, type SharedPeek } from './open-peek.js';
import { createPersonalVault, openPrivateVault } from './open-private.js';
import { openSharedVault } from './open-shared.js';
import { errCode, removeStagedCopy } from './open-staging.js';

export {
  INVALID_PASSWORD_MESSAGE,
  OPEN_CANCELLED_MESSAGE,
  PersonalVaultOpenError,
  VAULT_EXISTS_MESSAGE,
  VAULT_NOT_FOUND_MESSAGE,
  type OpenErrorCode,
  type OpenErrorPayload,
} from './open-errors.js';
export type { OpenCollaborators } from './open-deps.js';

/** The nine unlock paths of desktop-vault-lifecycle section 1. */
export type UnlockSource =
  | 'vault_initialize'
  | 'vault_unlock'
  | 'biometric_unlock'
  | 'vault_create'
  | 'vault_rename'
  | 'migrate_legacy_vault'
  | 'cloud_vault_restore'
  | 'cloud_backup_restore'
  | 'local_backup_restore';

export interface OpenPersonalVaultInput {
  readonly path: string;
  readonly password: string;
  /** Second attempt after VAULT_PASSWORD_CHANGED_ELSEWHERE { needsPreviousPassword }. */
  readonly previousPassword: string | null;
  readonly source: UnlockSource;
  /** [Use here instead] (6.5): acquire with takeover; signed out: write the claim anyway. */
  readonly takeover: boolean;
  /** vault_initialize / vault_create: the file must not exist; a new vault is created and published. */
  readonly create: boolean;
  /**
   * The user's answer to VAULT_WORKING_COPY_DAMAGED { recoverable }: park the damaged working
   * copy and seed it again from the shared file. Omitted: false.
   */
  readonly recoverWorkingCopy?: boolean;
}

export interface OpenedPersonalVault {
  readonly lineageId: string;
  readonly shared: boolean;
  readonly runtime: PersonalVaultRuntime;
  /** null for private vaults (opened in place). */
  readonly replica: ReplicaPort | null;
  readonly engine: SyncEngine | null;
  readonly unlock: Extract<UnlockDecision, { ok: true }> | null;
  /** The unlock cycle did not finish within UNLOCK_CYCLE_BUDGET_MS (it keeps running). */
  readonly firstCyclePending: boolean;
}

/** UI hooks for waits inside the open (4.4 G1 wait). */
export interface OpenProgress {
  waiting(state: WaitingState | null): void;
  /** Resolves when the user clicks [Continue anyway]; never rejects. */
  continueRequested(): Promise<void>;
  /** Resolves when a lock or quit arrives during this open; long waits end with OPEN_CANCELLED_MESSAGE. */
  cancelRequested?(): Promise<void>;
}

export interface OpenDeps {
  readonly host: SessionHost;
  readonly config: SessionConfig;
  readonly progress: OpenProgress;
  /** Defaults to sync-engine.assembleSyncEngine; tests may pass a fake. */
  readonly assembleEngine?: (input: AssembleInput) => SyncEngine;
  /** The process-lifetime registry created at app start; defaults to one module-level registry. */
  readonly incarnations?: IncarnationRegistry;
  /** Tests: the replica reloads W after every commit and checks the digest. */
  readonly verifyCommits?: boolean;
  /** Test seams: any subset of the collaborators; the rest are the real modules. */
  readonly collaborators?: Partial<OpenCollaborators>;
}

export async function openPersonalVault(input: OpenPersonalVaultInput, deps: OpenDeps): Promise<OpenedPersonalVault> {
  const ctx = makeOpenContext(input, deps);
  try {
    const loc = await resolveVaultLocation(input.path, deps);
    await ctx.host.fs.mkdir(ctx.stagingDir);
    await pruneStaleStaging(ctx);
    if (input.create) return await createPersonalVault(ctx, loc);
    if (!loc.shared) return await openPrivateVault(ctx, loc);
    return await openShared(ctx, loc);
  } catch (err) {
    logFailure(ctx, err);
    throw err;
  } finally {
    for (const p of ctx.staged.list()) await removeStagedCopy(p, ctx.host);
  }
}

/** Peek copies an earlier open left behind (a crash mid-open) go once they are an hour old. */
async function pruneStaleStaging(ctx: OpenContext): Promise<void> {
  try {
    await cleanupScratch(ctx.stagingDir, ctx.host.clock.now(), ctx.host);
  } catch (err) {
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: stale peek copies could not be removed`, { code: errCode(err) });
  }
}

/** Steps 2-4 before anything is written or leased, then steps 5-8. */
async function openShared(ctx: OpenContext, loc: VaultLocation): Promise<OpenedPersonalVault> {
  const peek = await peekShared(ctx, loc);
  await earlyInUseCheck(ctx, loc, { lineageId: peek.lineageId, shared: true, claimState: claimStateOf(peek), local: peek.local });
  const unlock = verifySharedPassword(ctx, peek);
  return openSharedVault(ctx, loc, peek, unlock);
}

/** 6.3 step 3 signed out or unconfirmed: the peeked S; when S is unusable, W (offline file mode). */
function claimStateOf(peek: SharedPeek): SyncState | null {
  return peek.s.kind === 'synced' ? peek.s.file.state : peek.w;
}

function logFailure(ctx: OpenContext, err: unknown): void {
  const meta = { source: ctx.input.source, takeover: ctx.input.takeover, create: ctx.input.create };
  if (err instanceof PersonalVaultOpenError) {
    ctx.host.logger.info(`${SESSION_LOG_PREFIX} open refused`, { ...meta, code: err.payload.code });
  } else if (err instanceof Error && err.message === INVALID_PASSWORD_MESSAGE) {
    ctx.host.logger.info(`${SESSION_LOG_PREFIX} open refused: wrong password`, meta);
  } else {
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open failed`, { ...meta, code: errCode(err) });
  }
}
