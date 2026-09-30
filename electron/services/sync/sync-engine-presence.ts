/**
 * This device's presence register as the engine writes it outside the cycle (spec 3.5, 5.3
 * step 1, 6.4, 6.11): the closed presence before the final cycle (session_open = 0 must reach
 * S with a publish) and the marker write of a direct publish (new vault, "Save a new copy here").
 */

import { presenceWrite } from './capture-local.js';
import { accountHint } from './hashing.js';
import { buildPresence, readPresence, samePresenceIgnoringActivity } from './presence.js';
import type { ApplyOptions, ReplicaPort } from './replica.js';
import type { SideFilesPort } from './side-files.js';
import type { SyncHost } from './host.js';
import type { AppDot, FileHint, PresenceValue } from './types.js';

export interface PresenceWriteInput {
  readonly sessionOpen: boolean;
  readonly sessionSinceMs: number | null;
  readonly fileHint: FileHint | null;
  /** Stamped into sync_state.file_id in the same commit (publish marker path). */
  readonly fileId?: string;
}

export interface PresenceDeps {
  readonly host: Pick<SyncHost, 'clock' | 'device' | 'account'>;
  readonly replica: ReplicaPort;
  readonly sideFiles: Pick<SideFilesPort, 'lastSeenMs'>;
}

/** W's version-vector entry for the current dev: the marker of the last write. */
export function markerOf(replica: Pick<ReplicaPort, 'dev' | 'state'>): AppDot | null {
  const dev = replica.dev();
  const h = replica.state().vv.get(dev);
  return h === undefined ? null : { dev, ms: h.ms, c: h.c };
}

/** W's presence for this device says the session is open (the final cycle must close it in S). */
export function presenceSaysOpen(replica: Pick<ReplicaPort, 'state' | 'deviceUuid'>): boolean {
  const p = readPresence(replica.state(), replica.deviceUuid);
  return p !== null && p.value.session_open === 1;
}

function presenceValue(deps: PresenceDeps, prev: PresenceValue | null, input: PresenceWriteInput): PresenceValue {
  const { host, replica } = deps;
  const userId = host.account.userId();
  return buildPresence(prev, {
    device: host.device.current(),
    nowMs: host.clock.now(),
    sessionOpen: input.sessionOpen,
    sessionSinceMs: input.sessionOpen ? input.sessionSinceMs : null,
    accountHint: userId === null ? null : accountHint(replica.lineageId, userId),
    fileHint: input.fileHint,
    sideFilesSeenMs: deps.sideFiles.lastSeenMs(),
  });
}

function commitPresence(deps: PresenceDeps, value: PresenceValue, fileId: string | undefined): AppDot | null {
  const { replica } = deps;
  const opts: ApplyOptions =
    fileId === undefined ? { interactive: true, ruleR: false } : { interactive: true, ruleR: false, fileId };
  replica.applyWrites([presenceWrite(value, replica.context())], opts);
  return markerOf(replica);
}

/** Builds and commits the presence register under one interactive dot (rule R off); returns the marker. */
export function writePresence(deps: PresenceDeps, input: PresenceWriteInput): AppDot | null {
  const prev = readPresence(deps.replica.state(), deps.replica.deviceUuid);
  return commitPresence(deps, presenceValue(deps, prev?.value ?? null, input), input.fileId);
}

/**
 * 3.5 "when a field changes": rewrites an existing presence whose fields (other than activity)
 * differ, e.g. the file hint after a rebind. A device that never announced itself writes nothing.
 */
export function refreshPresence(deps: PresenceDeps, input: PresenceWriteInput): boolean {
  const prev = readPresence(deps.replica.state(), deps.replica.deviceUuid);
  if (prev === null) return false;
  const next = presenceValue(deps, prev.value, input);
  if (samePresenceIgnoringActivity(prev.value, next)) return false;
  commitPresence(deps, next, input.fileId);
  return true;
}

/** 6.4 closing presence: session_open = 0 when presence still says open, as the engine's own write. */
export function writeClosingPresence(
  deps: PresenceDeps & { readonly binding: { fileHint(): FileHint | null } },
  ownWrites: <T>(fn: () => T) => T,
): void {
  if (!presenceSaysOpen(deps.replica)) return;
  ownWrites(() => writePresence(deps, { sessionOpen: false, sessionSinceMs: null, fileHint: deps.binding.fileHint() }));
}
