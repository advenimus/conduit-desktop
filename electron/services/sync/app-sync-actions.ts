/**
 * File, device and password actions of an open personal vault (spec 4.8, 5.5, 5.8, 5.9, 5.10
 * restores, 5.11, 6.11): Sync now, the device list, other copies, side-file confirmation,
 * locate and save-a-copy, separate vault, export, prompt dismissals, the password flows after
 * a change on another device, and backup rollback or restore-as-new-vault. Thin wrappers over
 * the engine's lane with IPC input validation (app-sync-dto-map.ts).
 */

import path from 'node:path';
import { listPresence } from './presence.js';
import { readBackupContent, restoreAsNewVault, rollbackChange, rollbackPreview, type BackupContent } from './restore.js';
import { SYNC_LOG_PREFIX, type SessionRowView } from './host.js';
import type { SideFileTuple } from './types.js';
import { InvalidSyncRequest, oneOf, requireString, rollbackPreviewDto } from './app-sync-dto-map.js';
import type { EngineVault } from './app-sync-review.js';
import type * as Dto from './app-sync-dto.js';

const SIDE_FILE_NAMES = ['wal', 'shm'] as const;

// ---------- Sync now and devices ----------

export async function syncNow(v: EngineVault): Promise<Dto.SyncNowResult> {
  const outcome = await v.engine.syncNow();
  return { outcome: outcome.kind };
}

function serverView(row: SessionRowView | undefined): Dto.SyncDeviceInfo['server'] {
  if (row === undefined) return null;
  return {
    status: row.status,
    lastActiveMs: row.lastActiveMs,
    busySessions: row.busySessions,
    busyJobs: row.busyJobs,
    pendingChanges: row.pendingChanges,
  };
}

/** Presence registers of the file merged with the server's session rows (signed in). */
export function listDevices(v: EngineVault, sessions: readonly SessionRowView[]): Dto.SyncDeviceInfo[] {
  const own = v.replica.deviceUuid;
  const byId = new Map(sessions.map((s) => [s.deviceId.toLowerCase(), s] as const));
  const out: Dto.SyncDeviceInfo[] = listPresence(v.replica.state()).map((p) => ({
    deviceUuid: p.deviceUuid,
    name: p.value.name,
    platform: p.value.platform,
    appVersion: p.value.app_version,
    thisDevice: p.deviceUuid === own,
    sessionOpen: p.value.session_open === 1,
    lastActiveMs: p.value.last_active_ms,
    fileHint: p.value.file_hint,
    server: serverView(byId.get(p.deviceUuid.toLowerCase())),
  }));
  const known = new Set(out.map((d) => d.deviceUuid.toLowerCase()));
  for (const s of sessions) {
    if (known.has(s.deviceId.toLowerCase())) continue;
    const fileHint = s.fileId === null ? null : { file_id: s.fileId, location: s.location ?? '', file_name: s.fileName ?? '' };
    out.push({
      deviceUuid: s.deviceId,
      name: s.deviceName,
      platform: s.platform,
      appVersion: null,
      thisDevice: false,
      sessionOpen: s.status === 'active',
      lastActiveMs: s.lastActiveMs,
      fileHint,
      server: serverView(s),
    });
  }
  return out;
}

// ---------- Other copies (5.8) ----------

export async function listCopies(v: EngineVault, rescan: unknown): Promise<readonly Dto.CopyInfo[]> {
  if (rescan === true) await v.engine.scanCopies();
  return v.engine.parts().status.snapshot().otherCopies;
}

function scannedCopy(v: EngineVault, copyPath: string) {
  const copy = v.engine.parts().scanner.last()?.copies.find((c) => c.path === copyPath);
  if (copy === undefined) throw new InvalidSyncRequest('that copy is no longer next to the vault; scan again');
  return copy;
}

export async function copyAction(v: EngineVault, rawPath: unknown, rawAction: unknown, targetPath: unknown): Promise<Dto.CopyActionResult> {
  const copyPath = requireString(rawPath, 'copy path');
  const action = oneOf(rawAction, ['trash', 'ignore', 'review', 'merge', 'separate'] as const, 'copy action');
  const { engine } = v;
  const { scanner, status } = engine.parts();
  switch (action) {
    case 'trash':
      await scanner.trash(copyPath);
      await engine.scanCopies();
      return { candidateId: null };
    case 'ignore':
      return ignoreCopy(v, copyPath);
    case 'review': {
      const copy = scannedCopy(v, copyPath);
      const candidateId = await engine.exclusive(() => scanner.queueForReview(copy));
      status.clearPrompt(`copy-review:${copy.sha256}`);
      status.setPrompt({ kind: 'candidate', id: `candidate:${candidateId}`, candidateId, label: copy.name });
      return { candidateId };
    }
    case 'merge':
      await engine.resolveSameDeviceCopy('merge', copyPath, null);
      return { candidateId: null };
    case 'separate':
      await engine.resolveSameDeviceCopy('separate', copyPath, requireString(targetPath, 'target path'));
      return { candidateId: null };
  }
}

async function ignoreCopy(v: EngineVault, copyPath: string): Promise<Dto.CopyActionResult> {
  const { engine } = v;
  const prompts = engine.parts().status.snapshot().prompts;
  const sameDevice = prompts.some((p) => p.kind === 'same-device-copy' && p.copy.path === copyPath);
  if (sameDevice) {
    await engine.resolveSameDeviceCopy('ignore', copyPath, null);
    return { candidateId: null };
  }
  const copy = scannedCopy(v, copyPath);
  engine.parts().scanner.ignore(copy.sha256);
  engine.parts().status.clearPrompt(`copy-review:${copy.sha256}`);
  await engine.scanCopies();
  return { candidateId: null };
}

// ---------- Side files (5.5) ----------

function toTuples(v: unknown): SideFileTuple[] {
  if (!Array.isArray(v)) throw new InvalidSyncRequest('side files');
  return v.map((t) => {
    const r = t as Readonly<Record<string, unknown>>;
    if (typeof r !== 'object' || r === null || typeof r.exists !== 'boolean') throw new InvalidSyncRequest('side file');
    if (typeof r.size !== 'number' || typeof r.mtimeMs !== 'number') throw new InvalidSyncRequest('side file');
    return { name: oneOf(r.name, SIDE_FILE_NAMES, 'side file name'), exists: r.exists, size: r.size, mtimeMs: r.mtimeMs };
  });
}

export function sideFileTuples(v: EngineVault): readonly Dto.SideFileTuple[] {
  return v.engine.parts().sideFiles.view().tuples;
}

export async function confirmSideFiles(v: EngineVault, tuples: unknown, walReviewed: unknown): Promise<Dto.ConfirmSideFilesResult> {
  const res = await v.engine.confirmSideFiles(toTuples(tuples), walReviewed === true);
  return { kind: res.kind };
}

// ---------- Binding (5.9) ----------

export function locate(v: EngineVault, filePath: unknown): Promise<boolean> {
  return v.engine.locate(requireString(filePath, 'file'));
}

export function saveNewCopy(v: EngineVault, filePath: unknown): Promise<boolean> {
  return v.engine.saveNewCopyHere(requireString(filePath, 'file'));
}

export async function undoRebind(v: EngineVault): Promise<boolean> {
  const ok = await v.engine.exclusive(() => v.engine.parts().binding.undoRebind());
  if (ok) v.engine.trigger('sync-now');
  return ok;
}

/** [Keep separate] / [Use as a separate vault]: fork W to a new file; `promptId` of a different-copies prompt is closed. */
export async function makeSeparateVault(v: EngineVault, targetPath: unknown, promptId: unknown): Promise<Dto.ForkResultDto> {
  const res = await v.engine.makeSeparateVault(requireString(targetPath, 'target path'));
  if (typeof promptId === 'string') closeDifferentCopies(v, promptId, 'dismiss');
  return { path: res.path, lineageId: res.lineageId };
}

function closeDifferentCopies(v: EngineVault, promptId: string, how: 'dismiss' | 'snooze'): void {
  const { status, divergence } = v.engine.parts();
  const prompt = status.snapshot().prompts.find((p) => p.id === promptId);
  if (prompt?.kind === 'different-copies') {
    if (how === 'dismiss') divergence.dismiss(prompt.deviceUuid, prompt.theirs.file_id);
    else divergence.snooze(prompt.deviceUuid, Date.now());
  }
  status.clearPrompt(promptId);
}

/** [Remind me later] and other dismissals; a prompt whose cause remains comes back at the next cycle. */
export function dismissPrompt(v: EngineVault, promptId: unknown): void {
  closeDifferentCopies(v, requireString(promptId, 'prompt'), 'snooze');
}

export function dismissNotice(v: EngineVault, noticeId: unknown): boolean {
  return v.engine.parts().notices.dismiss(requireString(noticeId, 'notice'));
}

export async function exportUnsynced(v: EngineVault): Promise<string> {
  const target = await v.engine.exportUnsynced();
  v.engine.parts().host.logger.info(`${SYNC_LOG_PREFIX} unsynced changes exported`, { file: path.basename(target) });
  return target;
}

// ---------- Password changed elsewhere (4.8) ----------

function requirePassword(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new InvalidSyncRequest(what);
  return v;
}

export async function enterNewPassword(v: EngineVault, password: unknown): Promise<Dto.PasswordFlowResult> {
  const decision = await v.engine.enterNewPassword(requirePassword(password, 'password'));
  if (decision.ok) return { ok: true };
  return { ok: false, reason: decision.reason };
}

export async function adoptLegacyPassword(v: EngineVault, newPassword: unknown, previousPassword: unknown): Promise<Dto.PasswordFlowResult> {
  const prev = previousPassword === null || previousPassword === undefined ? null : requirePassword(previousPassword, 'previous password');
  await v.engine.adoptLegacyPasswordChange(requirePassword(newPassword, 'password'), prev);
  return { ok: true };
}

export async function resolveConcurrentEpoch(v: EngineVault, otherPassword: unknown, winnerEpochId: unknown): Promise<Dto.PasswordFlowResult> {
  await v.engine.resolveConcurrentEpoch(requirePassword(otherPassword, 'password'), requireString(winnerEpochId, 'epoch'));
  return { ok: true };
}

// ---------- Backup restore (5.10) ----------

async function readBackup(v: EngineVault, backupPath: string, password: string): Promise<BackupContent> {
  const host = v.engine.parts().host;
  const backup = await readBackupContent(backupPath, v.replica.paths.tmp, (salt) => host.kdf.deriveKey(password, salt), host);
  if (backup.keys === null) throw new Error('Invalid master password');
  return backup;
}

/** Preview, rollback (interactive writes) or restore as a new vault, from a backup file already on disk. */
export async function restoreFromBackup(
  v: EngineVault,
  backupPath: string,
  password: string,
  mode: Dto.RestoreMode,
  targetPath: string | null,
): Promise<Dto.RestoreResult> {
  const backup = await readBackup(v, backupPath, password);
  if (mode === 'new-vault') {
    if (targetPath === null) throw new InvalidSyncRequest('target path');
    const keys = backup.keys as NonNullable<BackupContent['keys']>;
    const host = v.engine.parts().host;
    const res = await restoreAsNewVault(backupPath, keys.kEpoch, targetPath, v.replica.paths.tmp, host);
    return { mode: 'new-vault', path: res.path, lineageId: res.lineageId };
  }
  return v.engine.exclusive(() => {
    const input = { backup, current: v.replica.state(), ctx: v.replica.context(), implicit: v.replica.implicit() };
    if (mode === 'preview') return { mode: 'preview', preview: rollbackPreviewDto(rollbackPreview(input)) } as const;
    const { writes, changes } = rollbackChange(input);
    if (writes.length > 0) v.replica.applyWrites(writes, { interactive: true });
    return { mode: 'rollback', applied: changes } as const;
  });
}
