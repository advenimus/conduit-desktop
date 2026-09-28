/**
 * The reading half of one sync attempt (spec 5.2, 5.5, 5.9):
 * read S with the 30 s missing-file debounce and rebind, the torn-file retry and quarantine,
 * the side files as they are right now (a publish must never rename over a live 0.17 connection
 * the last 3 s poll has not seen yet), and the G2 baseline (genesis.conduit) through a private
 * copy. Used only by sync-cycle.ts.
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { statSideFileTuples, type SideFilesView } from './side-files.js';
import { loadContent } from './state-store.js';
import { showSideFiles } from './sync-engine-watch.js';
import type { GenesisBaseline } from './sync-absorb.js';
import type { SharedSnapshot } from './shared-file.js';
import type { CycleEnv, MissingEpisode } from './sync-cycle.js';
import type { CycleOutcome } from './sync-engine-types.js';
import { SYNC_LOG_PREFIX } from './host.js';

const BASELINE_RAND_BYTES = 8;
const SQLITE_SIDE_SUFFIXES = ['', '-wal', '-shm'] as const;

export type ReadStep =
  | { readonly kind: 'ok'; readonly snapshot: SharedSnapshot }
  /** The binding moved (rebind) or the original name came back: read again. */
  | { readonly kind: 'again' }
  | { readonly kind: 'done'; readonly outcome: CycleOutcome };

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function sameEpisode(a: MissingEpisode | null, b: MissingEpisode): boolean {
  return a !== null && a.path === b.path && a.sinceMs === b.sinceMs;
}

/**
 * The folder search reads and checks every vault file in S's folder, so it runs once per missing
 * episode; later cycles of that episode (local edits, safety polls) only raise the prompt again.
 */
async function missing(env: CycleEnv, sharedPath: string): Promise<ReadStep> {
  const { binding, host, notices, status } = env.deps;
  const verdict = binding.observeMissing(host.clock.now());
  if (verdict.kind !== 'missing') return { kind: 'done', outcome: { kind: 'missing', debounced: false } };
  const episode: MissingEpisode = { path: sharedPath, sinceMs: verdict.sinceMs };
  if (!sameEpisode(env.memory.missingProbed, episode)) {
    const res = await binding.resolveMissing();
    env.checkAlive();
    if (res.kind === 'rebound') {
      notices.toast('rebound', { from: path.basename(res.from), to: path.basename(res.to) });
      return { kind: 'again' };
    }
    if (res.kind === 'back') return { kind: 'again' };
    env.memory.missingProbed = episode;
  }
  status.setPrompt({ kind: 'file-missing', id: 'file-missing', path: sharedPath });
  return { kind: 'done', outcome: { kind: 'missing', debounced: true } };
}

/** Step 4.1: read S; missing S goes through the debounce, rebind or prompt of 5.9. */
export async function readStep(env: CycleEnv): Promise<ReadStep> {
  const { replica, shared, binding, status } = env.deps;
  const sharedPath = binding.sharedPath();
  const read = await shared.read(sharedPath, replica.paths.incoming);
  env.checkAlive();
  if (read.kind === 'unreachable') return { kind: 'done', outcome: { kind: 'unreachable', code: read.code } };
  if (read.kind === 'missing') return missing(env, sharedPath);
  binding.observePresent();
  status.clearPrompt('file-missing');
  env.memory.missingProbed = null;
  env.memory.lastShared = read.snapshot;
  return { kind: 'ok', snapshot: read.snapshot };
}

export type TornStep = { readonly kind: 'retry'; readonly outcome: CycleOutcome } | { readonly kind: 'republish' };

/** Step 4.2 unreadable S: retry at 5, 15, 45 s; after 2 minutes of the same bytes quarantine them. */
export async function tornStep(env: CycleEnv, snap: SharedSnapshot): Promise<TornStep> {
  const { host, shared, replica } = env.deps;
  const verdict = env.torn.observe(snap.sha256, host.clock.now());
  if (verdict.kind === 'retry') return { kind: 'retry', outcome: { kind: 'unreadable', retryAtMs: verdict.atMs } };
  if (verdict.kind === 'republish') return { kind: 'republish' };
  await shared.quarantine(snap, replica.paths.quarantine);
  env.torn.quarantined(snap.sha256);
  env.checkAlive();
  host.logger.warn(`${SYNC_LOG_PREFIX} unreadable shared file quarantined; republishing from the working copy`, {
    sha8: snap.sha256.slice(0, 8),
  });
  return { kind: 'republish' };
}

/**
 * Side files as they are now (5.5). The watcher's 3 s poll is not enough: a cycle started by a
 * folder event, a local edit or a verify check could otherwise publish over a live 0.17 app.
 */
export async function freshSideFiles(env: CycleEnv, sharedPath: string): Promise<SideFilesView> {
  const { sideFiles, session, host } = env.deps;
  const tuples = await statSideFileTuples(sharedPath, host.fs);
  env.checkAlive();
  const before = sideFiles.view();
  const after = sideFiles.observe(tuples);
  if (before.state !== after.state) showSideFiles(env.deps, after);
  if (before.holdLegacy !== after.holdLegacy) session.sideFilesChanged(after.holdLegacy);
  return after;
}

async function removeQuietly(env: CycleEnv, file: string): Promise<void> {
  for (const suffix of SQLITE_SIDE_SUFFIXES) {
    try {
      await env.deps.host.fs.rm(`${file}${suffix}`, { recursive: false, force: true });
    } catch (err) {
      env.deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a private baseline copy`, { code: errCode(err) });
    }
  }
}

function contentOf(file: string): GenesisBaseline['content'] {
  const db = new Database(file, { fileMustExist: true });
  try {
    return loadContent(db);
  } finally {
    db.close();
  }
}

/** genesis.conduit through a private copy (never opened in place), or null when absent or unreadable. */
export async function readBaseline(env: CycleEnv): Promise<GenesisBaseline | null> {
  const { replica, host } = env.deps;
  if ((await host.fs.stat(replica.paths.genesis)) === null) return null;
  const bytes = await host.fs.readFile(replica.paths.genesis);
  await host.fs.mkdir(replica.paths.tmp);
  const copy = path.join(replica.paths.tmp, `baseline-${host.random.bytes(BASELINE_RAND_BYTES).toString('hex')}.conduit`);
  await host.fs.writeFile(copy, bytes);
  try {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { content: contentOf(copy), sha256 };
  } catch (err) {
    host.logger.warn(`${SYNC_LOG_PREFIX} the genesis baseline could not be read`, { code: errCode(err) });
    return null;
  } finally {
    await removeQuietly(env, copy);
  }
}
