/**
 * User actions that change W or write files, run by SyncEngine inside its lane (spec 4.3 held
 * legacy changes, 5.8 same-device copies, 5.9 separate vault, 5.11 export, 4.8 password flows'
 * fresh read of S, and the local copies they move off the old password). Each returns what the engine needs; the engine clears prompts and runs the
 * follow-up cycle outside the lane.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { applyHeld } from './capture-legacy.js';
import { prepareWrite } from './capture-local.js';
import { forkAsSeparateVault, type ForkResult } from './file-binding.js';
import { provisional, regKeyStr, sibsOf } from './state-view.js';
import type { CommitOutcome } from './replica.js';
import type { FileKeyMeta } from './key-epoch.js';
import {
  adoptLegacyPasswordChange,
  adoptPresyncLegacyChange,
  enterNewPassword,
  resolveConcurrentEpoch,
  type EpochSnapshotPorts,
  type SharedForEpoch,
} from './sync-epoch.js';
import { sealAfterEpochChange } from './password-local-copies.js';
import type { SyncEngineDeps } from './sync-engine-types.js';
import type { CycleMemory } from './sync-cycle.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { HeldLegacyChange, LocalNotice, LocalWrite, RegKey, UnlockDecision } from './types.js';

export const VAULT_EXT = '.conduit';
export const EXPORT_SUFFIX = ' (unsynced changes)';
/** Export names tried (' 2', ' 3', ...) before giving up. */
export const EXPORT_NAME_ATTEMPTS = 1_000;
const TEMP_RAND_BYTES = 8;

export function fileStem(fileName: string): string {
  return fileName.toLowerCase().endsWith(VAULT_EXT) ? fileName.slice(0, -VAULT_EXT.length) : fileName;
}

function tempName(deps: SyncEngineDeps, prefix: string): string {
  return path.join(deps.replica.paths.tmp, `${prefix}-${deps.host.random.bytes(TEMP_RAND_BYTES).toString('hex')}${VAULT_EXT}`);
}

async function removeQuietly(deps: SyncEngineDeps, p: string): Promise<void> {
  try {
    await deps.host.fs.rm(p, { recursive: false, force: true });
  } catch (err) {
    deps.host.logger.warn(`${SYNC_LOG_PREFIX} could not remove a private temp file`, {
      file: path.basename(p),
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
  }
}

function clearHeld(deps: SyncEngineDeps): void {
  deps.replica.updateLocal((l) => (l.heldLegacy.length === 0 ? l : { ...l, heldLegacy: [] }));
}

/** 7.3 [Apply these changes]: capture-legacy.applyHeld on W, one commit, held list cleared. */
export function applyHeldChanges(deps: SyncEngineDeps): CommitOutcome | null {
  const { replica, notices } = deps;
  const held = replica.local().heldLegacy;
  if (held.length === 0) return null;
  const produced: { notices: readonly LocalNotice[] } = { notices: [] };
  const outcome = replica.commitWith((w) => {
    const res = applyHeld(w, held, replica.implicit(), replica.context());
    produced.notices = res.notices;
    return res.state;
  });
  clearHeld(deps);
  if (produced.notices.length > 0) notices.addFromCapture(produced.notices);
  return outcome;
}

function uniqueHeldKeys(held: readonly HeldLegacyChange[]): readonly RegKey[] {
  const byId = new Map<string, RegKey>();
  for (const h of held) byId.set(regKeyStr(h.key), h.key);
  return [...byId.values()];
}

/** Interactive re-assertion of the current provisional sibling of every held key. */
export function keepWrites(deps: SyncEngineDeps, held: readonly HeldLegacyChange[]): readonly LocalWrite[] {
  const { replica } = deps;
  const state = replica.state();
  const implicit = replica.implicit();
  const ctx = replica.context();
  const writes: LocalWrite[] = [];
  for (const key of uniqueHeldKeys(held)) {
    const current = provisional(key.reg, sibsOf(state, key, implicit));
    if (current === null) continue;
    writes.push(prepareWrite(key, { sibling: current }, ctx));
  }
  return writes;
}

/** 7.3 [Keep my versions]: one interactive dot re-asserting every held key; held list cleared. */
export function keepHeldVersions(deps: SyncEngineDeps): CommitOutcome | null {
  const { replica } = deps;
  const held = replica.local().heldLegacy;
  if (held.length === 0) return null;
  const writes = keepWrites(deps, held);
  const res = writes.length === 0 ? null : replica.applyWrites(writes, { interactive: true });
  clearHeld(deps);
  if (res === null) return null;
  return { state: res.state, changedRows: res.changedRows, structural: replica.structural(), generation: replica.generation() };
}

/** 5.11: exports/<stem> (unsynced changes).conduit, then ' 2', ' 3', ... when taken. */
export async function exportPathFor(deps: SyncEngineDeps, stem: string): Promise<string> {
  const dir = deps.replica.paths.exports;
  for (let n = 1; n <= EXPORT_NAME_ATTEMPTS; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    const candidate = path.join(dir, `${stem}${EXPORT_SUFFIX}${suffix}${VAULT_EXT}`);
    if ((await deps.host.fs.stat(candidate)) === null) return candidate;
  }
  throw new Error(`${SYNC_LOG_PREFIX} no free export file name`);
}

export async function exportWorkingCopy(deps: SyncEngineDeps): Promise<string> {
  await deps.host.fs.mkdir(deps.replica.paths.exports);
  const target = await exportPathFor(deps, fileStem(path.basename(deps.binding.sharedPath())));
  deps.shared.vacuumInto(deps.replica.database(), target);
  deps.host.logger.info(`${SYNC_LOG_PREFIX} exported unsynced changes`, { file: path.basename(target) });
  return target;
}

/** 5.9: fork a VACUUM INTO of W into a new vault at `targetPath`; W never changes. */
export async function forkWorkingCopy(deps: SyncEngineDeps, targetPath: string): Promise<ForkResult> {
  await deps.host.fs.mkdir(deps.replica.paths.tmp);
  const source = tempName(deps, 'fork');
  deps.shared.vacuumInto(deps.replica.database(), source);
  try {
    return await forkFile(deps, source, targetPath);
  } finally {
    await removeQuietly(deps, source);
  }
}

export function forkFile(deps: SyncEngineDeps, sourcePath: string, targetPath: string): Promise<ForkResult> {
  return forkAsSeparateVault(
    { sourcePath, key: deps.replica.ring().current.kEpoch, targetPath, workDir: deps.replica.paths.tmp },
    deps.host,
  );
}

export async function sha256OfFile(deps: SyncEngineDeps, p: string): Promise<string> {
  const bytes = await deps.host.fs.readFile(p);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Copies a user file into a private file and queues it as a candidate; returns the candidate. */
export async function queueFileCandidate(deps: SyncEngineDeps, filePath: string): Promise<{ id: string; label: string }> {
  await deps.host.fs.mkdir(deps.replica.paths.tmp);
  const staged = tempName(deps, 'copy');
  await deps.host.fs.copyFile(filePath, staged);
  const c = await deps.candidates.addFile({ path: staged, source: 'copy', label: path.basename(filePath), staleByNature: false });
  deps.status.setPrompt({ kind: 'candidate', id: `candidate:${c.id}`, candidateId: c.id, label: c.label });
  return { id: c.id, label: c.label };
}

/** S as a password flow sees it: synced, or pre-sync (a legacy change before the first publish). */
export type SharedForPassword =
  | { readonly kind: 'synced'; readonly shared: SharedForEpoch }
  | { readonly kind: 'presync'; readonly meta: FileKeyMeta; readonly sha256: string };

/**
 * The freshest S for a password flow (4.8): read and classify now, so the user's password is
 * checked against the file as it is, not as it was at the last cycle.
 */
export async function readSharedForPassword(deps: SyncEngineDeps, memory: CycleMemory): Promise<SharedForPassword> {
  const read = await deps.shared.read(deps.binding.sharedPath(), deps.replica.paths.incoming);
  if (read.kind !== 'ok') throw new Error(`${SYNC_LOG_PREFIX} the shared file cannot be read (${read.kind})`);
  memory.lastShared = read.snapshot;
  const cls = deps.shared.classify(read.snapshot, { lineageId: deps.replica.lineageId });
  const { sha256 } = read.snapshot;
  if (cls.kind === 'presync') return { kind: 'presync', meta: cls.meta, sha256 };
  if (cls.kind !== 'synced') throw new Error(`${SYNC_LOG_PREFIX} the shared file is not a copy of this vault (${cls.kind})`);
  return { kind: 'synced', shared: { file: cls.file, meta: cls.meta, sha256, mtimeMs: read.snapshot.stat.mtimeMs } };
}

/** 4.3 rule 2 hold inputs for a password flow that merges legacy writes. */
function holdNow(deps: SyncEngineDeps): { sideFilesPresent: boolean; serverSideFilesFlagRecent: boolean } {
  return {
    sideFilesPresent: deps.sideFiles.view().holdLegacy,
    serverSideFilesFlagRecent: deps.session.serverSideFilesFlagRecent(deps.host.clock.now()),
  };
}

/** 5.10: a password flow's merge is snapshotted into snapshots/ like a cycle's, notice included. */
function epochPorts(deps: SyncEngineDeps): EpochSnapshotPorts {
  return { snapshots: deps.snapshots, notices: deps.notices };
}

/** The freshest synced S (enter the new password, concurrent changes). */
export async function readSharedForEpoch(deps: SyncEngineDeps, memory: CycleMemory): Promise<SharedForEpoch> {
  const read = await readSharedForPassword(deps, memory);
  if (read.kind !== 'synced') throw new Error(`${SYNC_LOG_PREFIX} the shared file is not a synced copy of this vault (${read.kind})`);
  return read.shared;
}

/** 4.8 S newer, "Enter the new password": decides on the freshest S; the prompt clears on success. */
export async function enterNewPasswordAction(deps: SyncEngineDeps, memory: CycleMemory, password: string): Promise<UnlockDecision> {
  const shared = await readSharedForEpoch(deps, memory);
  const decision = await enterNewPassword(deps.replica, shared, password, deps.host, epochPorts(deps), holdNow(deps));
  if (!decision.ok) return decision;
  deps.status.clearPrompt('epoch-newer');
  await sealAfterEpochChange(deps);
  return decision;
}

/** 4.8 legacy password change in a synced or (12 row 64) pre-sync S. */
export async function adoptLegacyChangeAction(
  deps: SyncEngineDeps,
  memory: CycleMemory,
  newPassword: string,
  previousPassword: string | null,
): Promise<CommitOutcome> {
  const { replica, host, notices } = deps;
  const read = await readSharedForPassword(deps, memory);
  const out =
    read.kind === 'presync'
      ? adoptPresyncLegacyChange(replica, read, newPassword, previousPassword, host, notices)
      : await adoptLegacyPasswordChange(
          {
            replica,
            shared: read.shared,
            newPassword,
            previousPassword,
            ...holdNow(deps),
            ports: epochPorts(deps),
          },
          host,
        );
  deps.status.clearPrompt('epoch-legacy');
  await sealAfterEpochChange(deps);
  return out;
}

/** 4.8 concurrent changes: the other branch's password once, then the winner. */
export async function resolveConcurrentAction(
  deps: SyncEngineDeps,
  memory: CycleMemory,
  otherPassword: string,
  winnerEpochId: string,
): Promise<CommitOutcome> {
  const shared = await readSharedForEpoch(deps, memory);
  const input = { replica: deps.replica, shared, otherPassword, winnerEpochId, ports: epochPorts(deps), hold: holdNow(deps) };
  const out = await resolveConcurrentEpoch(input, deps.host);
  deps.status.clearPrompt('epoch-concurrent');
  await sealAfterEpochChange(deps);
  return out;
}
