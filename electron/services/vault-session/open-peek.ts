/**
 * Step 2 of the unlock sequence (spec 6.3, 3.1 lineage, 4.4, 5.2): S read through a private
 * staged copy and classified; the lineage from S's sync_state, or for a pre-sync or unusable
 * S from this device's binding (then from the salt); whether a W exists; W's state from a
 * private copy; local.json read without side effects. Nothing in the shared folder, W or the
 * lineage folder is written. S missing, unreadable or foreign with a W is "offline file" mode
 * (the engine reports it later); without a W it is the matching open error.
 */

import { lineageIdFromSalt } from '../sync/hashing.js';
import { validateLocalJson } from '../sync/local-state.js';
import { isErrno, lineagePaths } from '../sync/paths.js';
import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { FileKeyMeta } from '../sync/key-epoch.js';
import type { ClassifyExpectation, SharedSnapshot } from '../sync/shared-file.js';
import type { LoadedFile, LocalJson, SyncState } from '../sync/types.js';
import type { OpenContext } from './open-deps.js';
import { isWorkingCopyDamage } from './open-damaged.js';
import { fileProblemError, workingCopyDamagedError, type FileProblem } from './open-errors.js';
import type { VaultLocation } from './open-location.js';
import { errCode, isLineageId } from './open-staging.js';

export type SharedView =
  | { readonly kind: 'synced'; readonly snapshot: SharedSnapshot; readonly file: LoadedFile; readonly meta: FileKeyMeta }
  | { readonly kind: 'presync'; readonly snapshot: SharedSnapshot; readonly meta: FileKeyMeta }
  | { readonly kind: 'problem'; readonly problem: FileProblem; readonly snapshot: SharedSnapshot | null };

export type SyncedView = Extract<SharedView, { kind: 'synced' }>;

export interface SharedPeek {
  readonly lineageId: string;
  readonly s: SharedView;
  readonly hasW: boolean;
  /** W's state (private copy), null without W. */
  readonly w: SyncState | null;
  /** local.json when present and valid (never parked here). */
  readonly local: LocalJson | null;
  /** W exists but is damaged and the user chose to recover: park it, then seed from S (hasW false). */
  readonly damagedW: boolean;
}

const MISSING_KEY_META: FileProblem = { kind: 'unreadable', reason: 'missing-key-meta' };

function problem(p: FileProblem, snapshot: SharedSnapshot | null = null): SharedView {
  return { kind: 'problem', problem: p, snapshot };
}

/** Reads and classifies a shared file into the open's staging folder. */
export async function readSharedView(ctx: OpenContext, filePath: string, expect: ClassifyExpectation): Promise<SharedView> {
  const read = await ctx.c.readShared(filePath, ctx.stagingDir, ctx.host);
  if (read.kind === 'missing') return problem({ kind: 'missing' });
  if (read.kind === 'unreachable') return problem({ kind: 'unreachable', code: read.code });
  const snapshot = read.snapshot;
  ctx.staged.add(snapshot.stagedPath);
  const cls = ctx.c.classify(snapshot, expect);
  switch (cls.kind) {
    case 'unreadable':
      return problem({ kind: 'unreadable', reason: cls.reason }, snapshot);
    case 'foreign-newer':
      return problem({ kind: 'foreign-newer', syncFormat: cls.syncFormat }, snapshot);
    case 'foreign-other':
      return problem({ kind: 'foreign-other' }, snapshot);
    case 'presync':
      return { kind: 'presync', snapshot, meta: cls.meta };
    case 'synced':
      if (!isLineageId(cls.file.state.lineageId)) return problem({ kind: 'unreadable', reason: 'corrupt-sync-state' }, snapshot);
      return { kind: 'synced', snapshot, file: cls.file, meta: cls.meta };
  }
}

function problemOf(s: SharedView): FileProblem {
  if (s.kind === 'problem') return s.problem;
  return MISSING_KEY_META;
}

async function lineageFor(ctx: OpenContext, loc: VaultLocation, s: SharedView): Promise<string | null> {
  if (s.kind === 'synced') return s.file.state.lineageId;
  // A pre-sync file at a bound path is identified by the binding: a legacy password change changes the salt (3.1).
  const bound = await ctx.c.findBoundLineage(ctx.config.machineDir, loc.realpath, ctx.replicaDeps);
  if (bound !== null) return bound;
  if (s.kind === 'presync' && s.meta.salt !== null) return lineageIdFromSalt(s.meta.salt);
  return null;
}

/** Step 2 for a shared vault. Throws the open error when S cannot be used and no W exists. */
export async function peekShared(ctx: OpenContext, loc: VaultLocation): Promise<SharedPeek> {
  const s = await readSharedView(ctx, ctx.sharedPath, { lineageId: null });
  const lineageId = await lineageFor(ctx, loc, s);
  if (lineageId === null) throw fileProblemError(problemOf(s), ctx.fileName);
  const hasW = await ctx.c.hasWorkingCopy(ctx.config.machineDir, lineageId, ctx.replicaDeps);
  if (!hasW && s.kind === 'problem') throw fileProblemError(s.problem, ctx.fileName);
  const lp = lineagePaths(ctx.config.machineDir, lineageId);
  const local = await readLocalQuietly(lp.local, ctx);
  const w = hasW ? await readWorkingState(ctx, lp.working) : null;
  if (w === DAMAGED) {
    const recoverable = s.kind !== 'problem';
    if (!recoverable || ctx.input.recoverWorkingCopy !== true) throw workingCopyDamagedError(ctx.fileName, recoverable);
    return { lineageId, s, hasW: false, w: null, local, damagedW: true };
  }
  if (s.kind === 'problem') {
    ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: shared file unusable, opening from the working copy`, {
      problem: s.problem.kind,
      lineageId,
    });
  }
  return { lineageId, s, hasW, w, local, damagedW: false };
}

const DAMAGED = Symbol('damaged working copy');

async function readWorkingState(ctx: OpenContext, workingPath: string): Promise<SyncState | typeof DAMAGED> {
  try {
    return await ctx.c.readWorkingState(workingPath, ctx.stagingDir, ctx.host);
  } catch (err) {
    ctx.host.logger.error(`${SESSION_LOG_PREFIX} open: working copy could not be read`, { code: errCode(err) });
    if (isWorkingCopyDamage(err)) return DAMAGED;
    throw err;
  }
}

/** local.json without side effects: a missing or invalid file is null (the replica parks and rebuilds it). */
export async function readLocalQuietly(localPath: string, ctx: Pick<OpenContext, 'host'>): Promise<LocalJson | null> {
  let text: string;
  try {
    text = (await ctx.host.fs.readFile(localPath)).toString('utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: local.json could not be read`, { code: errCode(err) });
    return null;
  }
  try {
    const v = validateLocalJson(JSON.parse(text));
    if (v.ok) return v.value;
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: local.json is invalid; the replica will rebuild it`, { errors: v.errors.length });
  } catch (err) {
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: local.json is not JSON; the replica will rebuild it`, { code: errCode(err) });
  }
  return null;
}
