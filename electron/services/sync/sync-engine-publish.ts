/**
 * Direct publishes outside the cycle (spec 5.3, 5.9 "Save a new copy here", 6.3 create): the
 * presence marker with file_id in W, VACUUM INTO a private snapshot, then the CAS publish to a
 * path that must not exist yet (expectedSha256 null) or to the bound S. The caller records the
 * publish (verification, marker report). The cycle's own publish lives in sync-cycle.ts.
 */

import path from 'node:path';
import { writePresence, type PresenceDeps } from './sync-engine-presence.js';
import type { PublishOutcome, SharedFilePort } from './shared-file.js';
import type { SyncHost } from './host.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { AppDot, FileHint, SyncState } from './types.js';

const SNAPSHOT_RAND_BYTES = 8;

export interface DirectPublishInput {
  readonly targetPath: string;
  readonly fileId: string;
  readonly fileHint: FileHint;
  /** null: the target must not exist (first publish of a new file). */
  readonly expectedSha256: string | null;
  readonly observedMtimeMs: number | null;
  readonly sessionOpen: boolean;
  readonly sessionSinceMs: number | null;
}

export interface DirectPublishDeps extends PresenceDeps {
  readonly host: Pick<SyncHost, 'clock' | 'device' | 'account' | 'fs' | 'random' | 'logger'>;
  readonly shared: Pick<SharedFilePort, 'vacuumInto' | 'publish'>;
  /** Runs the marker write so the engine does not count it as a user edit. */
  readonly ownWrites: <T>(fn: () => T) => T;
}

export type DirectPublishResult =
  | {
      readonly kind: 'published';
      readonly sha256: string;
      readonly mtimeMs: number;
      readonly marker: AppDot;
      /** W exactly as vacuumed (P of 5.7). */
      readonly state: SyncState;
    }
  | Exclude<PublishOutcome, { kind: 'published' }>;

export async function publishDirect(deps: DirectPublishDeps, input: DirectPublishInput): Promise<DirectPublishResult> {
  const { host, replica, shared } = deps;
  await host.fs.mkdir(replica.paths.tmp);
  const snapshotPath = path.join(replica.paths.tmp, `publish-${host.random.bytes(SNAPSHOT_RAND_BYTES).toString('hex')}.conduit`);
  // No await between the marker write and VACUUM INTO: P is exactly what the snapshot holds.
  const marker = deps.ownWrites(() =>
    writePresence(deps, {
      sessionOpen: input.sessionOpen,
      sessionSinceMs: input.sessionSinceMs,
      fileHint: input.fileHint,
      fileId: input.fileId,
    }),
  );
  const state = replica.state();
  if (marker === null) throw new Error(`${SYNC_LOG_PREFIX} presence write left no marker`);
  shared.vacuumInto(replica.database(), snapshotPath);
  const outcome = await shared.publish({
    sharedPath: input.targetPath,
    snapshotPath,
    expectedSha256: input.expectedSha256,
    observedMtimeMs: input.observedMtimeMs,
  });
  if (outcome.kind !== 'published') {
    host.logger.warn(`${SYNC_LOG_PREFIX} direct publish did not complete`, {
      outcome: outcome.kind,
      code: outcome.kind === 'failed' ? outcome.code : null,
      file: path.basename(input.targetPath),
    });
    return outcome;
  }
  replica.updateLocal((l) => ({
    ...l,
    lastPublished: { sha256: outcome.sha256, markerDot: marker },
    pendingPublish: false,
  }));
  host.logger.info(`${SYNC_LOG_PREFIX} published`, {
    file: path.basename(input.targetPath),
    sha8: outcome.sha256.slice(0, 8),
    inPlace: outcome.inPlace,
  });
  return { kind: 'published', sha256: outcome.sha256, mtimeMs: outcome.mtimeMs, marker, state };
}
