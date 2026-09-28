/**
 * Review actions of an open personal vault (spec 4.7, 4.9, 5.10, 7.2-7.4): the
 * conflict queue and its resolutions, snooze, reveal and recovery of secrets, candidates, held
 * legacy changes, targeted undo, Recently deleted. Every write runs in the engine's lane and
 * is followed by a conflict recount and a cycle. Inputs arrive unvalidated from IPC and are
 * checked in app-sync-dto-map.ts.
 */

import {
  discardUndecryptable,
  listConflicts,
  recoverUndecryptable,
  resolveAppearance,
  resolveBulk,
  resolveCycle,
  resolveEditDelete,
  resolveField,
  resolveFolderDelete,
  revealSecret,
  type ConflictContext,
} from './conflicts.js';
import { findVersion } from './conflicts-shared.js';
import { countUndone } from './snapshots.js';
import { regKeyStr } from './state-view.js';
import { countConflicts } from './sync-cycle-merge.js';
import { deletePermanently, emptyRecentlyDeleted, listRecentlyDeleted, restoreWrites } from './tombstones.js';
import { queueFileCandidate } from './sync-engine-actions.js';
import { SYNC_LOG_PREFIX } from './host.js';
import type { ReplicaPort } from './replica.js';
import type { SyncEngine } from './sync-engine.js';
import type { LocalWrite } from './types.js';
import {
  InvalidSyncRequest,
  candidatePreviewDto,
  deletedDto,
  deviceNameOfUuid,
  groupDto,
  oneOf,
  requireString,
  toAppearanceChoices,
  toFieldChoice,
  toRegKey,
  toRegKeys,
  toRowKey,
  toRowKeys,
  undoPreviewDto,
} from './app-sync-dto-map.js';
import type * as Dto from './app-sync-dto.js';

/** The open, engine-managed personal vault. */
export interface EngineVault {
  readonly replica: ReplicaPort;
  readonly engine: SyncEngine;
}

/** local.json snoozes kept (newest first). */
export const SNOOZES_KEPT = 500;

export function conflictContext(replica: ReplicaPort): ConflictContext {
  const local = replica.local();
  const repaired = local.notices.flatMap((n) => (n.kind === 'invariant-repair' && n.key !== null ? [regKeyStr(n.key)] : []));
  return {
    implicit: replica.implicit(),
    structural: replica.structural(),
    snoozed: new Set(local.snoozed.map((s) => s.key)),
    candidateLabels: new Map(Object.entries(local.candidateLabels).map(([dev, label]) => [Number(dev), label] as const)),
    repairedKeys: new Set(repaired),
    keys: replica.ring(),
  };
}

function recount(v: EngineVault): Dto.ResolveResult {
  const count = countConflicts(v.replica, v.replica.state());
  v.engine.parts().status.setConflicts(count);
  return { conflictCount: count };
}

/** Applies interactive writes in the lane, recounts, and lets the local-edit trigger publish. */
async function applyInteractive(v: EngineVault, build: () => readonly LocalWrite[]): Promise<Dto.ResolveResult> {
  return v.engine.exclusive(() => {
    const writes = build();
    if (writes.length > 0) v.replica.applyWrites(writes, { interactive: true });
    return recount(v);
  });
}

// ---------- Conflicts ----------

export function listConflictGroups(v: EngineVault): Dto.ConflictGroup[] {
  return listConflicts(v.replica.state(), conflictContext(v.replica)).map(groupDto);
}

function resolveWrites(v: EngineVault, req: Readonly<Record<string, unknown>>): readonly LocalWrite[] {
  const state = v.replica.state();
  const ctx = v.replica.context();
  switch (req.kind) {
    case 'field':
      return resolveField(state, toRegKey(req.key), toFieldChoice(req.choice), ctx);
    case 'edit-delete':
      return resolveEditDelete(state, toRowKey(req.row), oneOf(req.choice, ['keep', 'delete'], 'choice'), ctx);
    case 'folder-delete': {
      const choice = oneOf(req.choice, ['keep-with-changed', 'delete-all', 'restore-all'], 'choice');
      return resolveFolderDelete(state, toRowKey(req.folder), choice, ctx, v.replica.implicit());
    }
    case 'cycle':
      return resolveCycleRequest(v, req);
    case 'undecryptable-discard':
      return discardUndecryptable(state, toRegKey(req.key), ctx);
    default:
      throw new InvalidSyncRequest('resolve kind');
  }
}

function resolveCycleRequest(v: EngineVault, req: Readonly<Record<string, unknown>>): readonly LocalWrite[] {
  const cycle = v.replica.structural().find((c) => c.tbl === req.tbl && sameIds(c.rowIds, req.rowIds));
  if (cycle === undefined) throw new InvalidSyncRequest('the folders are no longer in a loop');
  const choice = req.choice as Readonly<Record<string, unknown>> | null;
  if (choice?.kind === 'all-root') return resolveCycle(cycle, { kind: 'all-root' }, v.replica.context());
  if (choice?.kind !== 'put-under') throw new InvalidSyncRequest('cycle choice');
  const pick = { kind: 'put-under', child: requireString(choice.child, 'child'), parent: requireString(choice.parent, 'parent') } as const;
  return resolveCycle(cycle, pick, v.replica.context());
}

function sameIds(a: readonly string[], b: unknown): boolean {
  return Array.isArray(b) && b.length === a.length && [...b].sort().every((x, i) => x === a[i]);
}

export function resolve(v: EngineVault, req: unknown): Promise<Dto.ResolveResult> {
  if (typeof req !== 'object' || req === null) throw new InvalidSyncRequest('request');
  return applyInteractive(v, () => resolveWrites(v, req as Readonly<Record<string, unknown>>));
}

export function resolveGroup(v: EngineVault, req: unknown): Promise<Dto.ResolveResult> {
  if (typeof req !== 'object' || req === null) throw new InvalidSyncRequest('request');
  const r = req as Readonly<Record<string, unknown>>;
  return applyInteractive(v, () => {
    const state = v.replica.state();
    const ctx = v.replica.context();
    if (r.kind === 'appearance') return resolveAppearance(state, toRowKey(r.row), toAppearanceChoices(r.choices), ctx);
    if (r.kind === 'bulk') {
      const choice = oneOf(r.choice, ['keep-newest-all', 'keep-newest-older-apps'], 'bulk choice');
      return resolveBulk(state, choice, conflictContext(v.replica), ctx);
    }
    throw new InvalidSyncRequest('group kind');
  });
}

/** 7.4 [Decide later]: per device, returns at the next unlock of a later launch. */
export function snooze(v: EngineVault, snoozeKey: unknown): Dto.ResolveResult {
  const key = requireString(snoozeKey, 'snooze key');
  const nowMs = Date.now();
  v.replica.updateLocal((l) =>
    l.snoozed.some((s) => s.key === key) ? l : { ...l, snoozed: [{ key, createdMs: nowMs }, ...l.snoozed].slice(0, SNOOZES_KEPT) },
  );
  return recount(v);
}

export function reveal(v: EngineVault, key: unknown, versionId: unknown): string | null {
  const sib = findVersion(v.replica.state(), toRegKey(key), requireString(versionId, 'version'));
  return revealSecret(sib, v.replica.ring());
}

/** [Enter old password] on an undecryptable value: false when no retained salt opens it. */
export async function recoverSecret(v: EngineVault, key: unknown, versionId: unknown, oldPassword: unknown): Promise<boolean> {
  const k = toRegKey(key);
  const id = requireString(versionId, 'version');
  if (typeof oldPassword !== 'string' || oldPassword === '') throw new InvalidSyncRequest('password');
  const memo = new Map<string, Buffer>();
  const derive = (salt: string): Buffer => {
    const hit = memo.get(salt) ?? v.engine.parts().host.kdf.deriveKey(oldPassword, salt);
    memo.set(salt, hit);
    return hit;
  };
  const probe = recoverUndecryptable(v.replica.state(), k, id, derive, v.replica.context());
  if (probe === null) return false;
  await v.engine.exclusive(() => v.replica.commitWith((w) => recoverUndecryptable(w, k, id, derive, v.replica.context())?.state ?? w));
  recount(v);
  v.engine.trigger('sync-now');
  return true;
}

// ---------- Candidates (4.9) ----------

export function listCandidates(v: EngineVault): Dto.CandidateSummary[] {
  return v.engine
    .parts()
    .candidates.list()
    .map((c) => ({ id: c.id, source: c.source, label: c.label, kind: c.kind, createdMs: c.createdMs }));
}

export async function candidatePreview(v: EngineVault, id: unknown): Promise<Dto.CandidatePreview> {
  const cid = requireString(id, 'candidate');
  return candidatePreviewDto(cid, await v.engine.parts().candidates.preview(cid));
}

export async function candidateApply(v: EngineVault, id: unknown, deleteMissing: unknown): Promise<Dto.ResolveResult> {
  const cid = requireString(id, 'candidate');
  const rows = deleteMissing === undefined ? [] : toRowKeys(deleteMissing);
  const res = await v.engine.exclusive(async () => {
    await v.engine.parts().candidates.apply(cid, { deleteMissing: rows });
    v.engine.parts().status.clearPrompt(`candidate:${cid}`);
    return recount(v);
  });
  v.engine.trigger('sync-now');
  return res;
}

export async function candidateDiscard(v: EngineVault, id: unknown): Promise<void> {
  const cid = requireString(id, 'candidate');
  await v.engine.exclusive(async () => {
    await v.engine.parts().candidates.discard(cid);
    v.engine.parts().status.clearPrompt(`candidate:${cid}`);
  });
}

/** [Merge them...] or a user-picked copy: queued as a candidate from a private copy. */
export async function candidateAddFile(v: EngineVault, filePath: unknown): Promise<string> {
  const p = requireString(filePath, 'file');
  const c = await v.engine.exclusive(() => queueFileCandidate(v.engine.parts(), p));
  return c.id;
}

// ---------- Held legacy changes (4.3, 7.3) ----------

export async function heldApply(v: EngineVault, choice: unknown): Promise<Dto.ResolveResult> {
  const pick = oneOf(choice, ['apply', 'keep-mine'], 'held choice');
  if (pick === 'apply') await v.engine.applyHeld();
  else await v.engine.keepHeld();
  return recount(v);
}

// ---------- Snapshots and targeted undo (5.10) ----------

export async function listSnapshots(v: EngineVault): Promise<Dto.SnapshotSummary[]> {
  const state = v.replica.state();
  const refs = await v.engine.parts().snapshots.list();
  return refs.map((r) => ({
    id: r.id,
    createdMs: r.meta.createdMs,
    noticeId: r.meta.noticeId,
    deleted: r.meta.deleted,
    changedRows: r.meta.changedRows,
    byDeviceName: deviceNameOfUuid(state, r.meta.byDeviceUuid),
  }));
}

export async function undoPreview(v: EngineVault, snapshotId: unknown): Promise<Dto.UndoPreview> {
  const id = requireString(snapshotId, 'snapshot');
  const { replica } = v;
  return undoPreviewDto(await v.engine.parts().snapshots.undoPreview(id, replica.state(), replica.implicit(), replica.ring()));
}

export async function undoApply(v: EngineVault, snapshotId: unknown, rows: unknown, fields: unknown): Promise<Dto.UndoApplyResult> {
  const id = requireString(snapshotId, 'snapshot');
  const choice = { rows: toRowKeys(rows ?? []), fields: toRegKeys(fields ?? []) };
  return v.engine.exclusive(async () => {
    const { replica } = v;
    const writes = await v.engine.parts().snapshots.undoWrites(id, replica.state(), choice, replica.ring(), replica.context());
    if (writes.length > 0) replica.applyWrites(writes, { interactive: true });
    recount(v);
    return { applied: countUndone(writes) };
  });
}

// ---------- Recently deleted (4.7) ----------

export function recentlyDeleted(v: EngineVault, showAll: unknown): Dto.RecentlyDeletedItem[] {
  const state = v.replica.state();
  return deletedDto(state, listRecentlyDeleted(state, Date.now(), showAll === true));
}

export function restoreDeleted(v: EngineVault, rows: unknown): Promise<Dto.ResolveResult> {
  const keys = toRowKeys(rows);
  return applyInteractive(v, () => restoreWrites(v.replica.state(), keys, v.replica.context()));
}

/** "Delete permanently": chosen rows, or everything in Recently deleted when `all`. */
export async function deleteForever(v: EngineVault, rows: unknown, all: unknown): Promise<void> {
  const keys = all === true ? null : toRowKeys(rows);
  await v.engine.exclusive(() =>
    v.replica.commitWith((w) => (keys === null ? emptyRecentlyDeleted(w) : deletePermanently(w, keys))),
  );
  v.engine.parts().host.logger.info(`${SYNC_LOG_PREFIX} deleted permanently`, { rows: keys === null ? 'all' : keys.length });
  v.engine.trigger('sync-now');
}
