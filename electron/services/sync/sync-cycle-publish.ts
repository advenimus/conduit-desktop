/**
 * The publish step of one sync attempt (spec 5.3 steps 1-5, 5.7, 6.11 markers): the file_id
 * rule, this device's presence register as the publish marker (with
 * sync_state.file_id, in W), VACUUM INTO a private snapshot with no await in between, the CAS
 * publish, and the bookkeeping of a successful publish (local.json, verification record, marker
 * report). Used only by sync-cycle.ts.
 */

import path from 'node:path';
import { readPresence } from './presence.js';
import { writePresence } from './sync-engine-presence.js';
import type { CycleEnv } from './sync-cycle.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { AppDot, FileBinding, SyncState } from './types.js';

/** 5.6 content repair: SHA-256s of S already repaired (at most once per distinct S). */
export const CONTENT_REPAIR_KEEP = 20;
const SNAPSHOT_RAND_BYTES = 8;

export interface PublishTarget {
  /** CAS: SHA-256 of the S that was merged (or the torn bytes being replaced). */
  readonly expectedSha256: string | null;
  readonly observedMtimeMs: number | null;
  /** sync_state.file_id of S when it is synced, else null. */
  readonly sFileId: string | null;
  /** SHA-256 of the S whose content repair this publish is, else null. */
  readonly repairSha: string | null;
}

export type PublishStep =
  | { readonly kind: 'published'; readonly sha256: string; readonly marker: AppDot }
  | { readonly kind: 'changed' }
  | { readonly kind: 'failed'; readonly code: string | null };

/**
 * 3.1 file_id: a binding that never published adopts S's file_id (joining an existing file).
 * Once this lineage has published, S's differing id belongs to another file (a same-device copy
 * opened with a fresh id, 5.8), so ours is kept.
 */
function bindFileId(env: CycleEnv, sFileId: string | null): FileBinding {
  const { binding, replica } = env.deps;
  const current = binding.binding();
  const publishedBefore = replica.local().lastPublished !== null;
  const other = sFileId !== null && sFileId !== current.fileId && publishedBefore;
  return binding.ensureFileId(sFileId, other);
}

function writeMarker(env: CycleEnv, fileId: string): AppDot {
  const { host, replica, sideFiles, session, binding } = env.deps;
  const open = !env.closing && session.sessionOpen();
  const since = open ? (readPresence(replica.state(), replica.deviceUuid)?.value.session_since_ms ?? host.clock.now()) : null;
  const write = (): AppDot | null =>
    writePresence({ host, replica, sideFiles }, { sessionOpen: open, sessionSinceMs: since, fileHint: binding.fileHint(), fileId });
  const marker = env.ownWrites === undefined ? write() : env.ownWrites(write);
  if (marker === null) throw new Error(`${SYNC_LOG_PREFIX} presence write left no marker`);
  return marker;
}

/** `genAtP`: W.gen when P was vacuumed; a local edit committed during the publish keeps pending_publish. */
function recordPublished(env: CycleEnv, target: PublishTarget, published: { sha256: string; marker: AppDot; p: SyncState; genAtP: number }): void {
  const { replica, host, session } = env.deps;
  const { sha256, marker, p, genAtP } = published;
  const now = host.clock.now();
  const coversW = replica.generation() === genAtP;
  replica.updateLocal((l) => ({
    ...l,
    lastPublished: { sha256, markerDot: marker },
    pendingPublish: coversW ? false : l.pendingPublish,
    contentRepairShas:
      target.repairSha === null || l.contentRepairShas.includes(target.repairSha)
        ? l.contentRepairShas
        : [...l.contentRepairShas, target.repairSha].slice(-CONTENT_REPAIR_KEEP),
  }));
  env.memory.lastPublishMs = now;
  env.verifier.recordPublish({ sha256, marker, state: p, atMs: now });
  session.published(marker);
}

/** 5.3: marker and file_id in W, VACUUM INTO, CAS publish; `changed` sends the loop round again. */
export async function publishStep(env: CycleEnv, target: PublishTarget): Promise<PublishStep> {
  const { replica, binding, shared, host } = env.deps;
  const bound = bindFileId(env, target.sFileId);
  await host.fs.mkdir(replica.paths.tmp);
  env.checkAlive();
  const snapshotPath = path.join(replica.paths.tmp, `publish-${host.random.bytes(SNAPSHOT_RAND_BYTES).toString('hex')}.conduit`);
  // No await between the marker write and VACUUM INTO: P is exactly what the snapshot holds.
  const marker = writeMarker(env, bound.fileId);
  const p = replica.state();
  const genAtP = replica.generation();
  shared.vacuumInto(replica.database(), snapshotPath);
  const out = await shared.publish({
    sharedPath: binding.sharedPath(),
    snapshotPath,
    expectedSha256: target.expectedSha256,
    observedMtimeMs: target.observedMtimeMs,
  });
  if (out.kind === 'changed') {
    host.logger.info(`${SYNC_LOG_PREFIX} the shared file changed before publishing; merging again`);
    return { kind: 'changed' };
  }
  if (out.kind === 'failed') return { kind: 'failed', code: out.code };
  recordPublished(env, target, { sha256: out.sha256, marker, p, genAtP });
  host.logger.info(`${SYNC_LOG_PREFIX} published`, { sha8: out.sha256.slice(0, 8), inPlace: out.inPlace });
  return { kind: 'published', sha256: out.sha256, marker };
}
